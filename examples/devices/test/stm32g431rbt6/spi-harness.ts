import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '../support/legacy-model-bridge.mjs';
import type { DeviceFactory } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * SPI1 固件端到端夹具：只使用真实 MCU 适配器、中央 `PERIPHERALS`（含 SPI）、
 * GPIO AF、SPI 服务节拍与板级 PA7–PA6 短接；不修改注册表或模型 profile。
 */

const MCU_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

interface McuModule {
  readonly model: DeviceIR;
  readonly create: unknown;
}

let mcuCache: Promise<McuModule> | undefined;

function loadMcu(): Promise<McuModule> {
  mcuCache ??= (async () => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(MCU_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      import(pathToFileURL(join(MCU_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
    ]);

    return { model, create: adapter.create };
  })();

  return mcuCache;
}

export interface SpiCircuitOptions {
  readonly firmware: Uint8Array;
  readonly clockFrequency?: number;
}

export interface SpiCircuit {
  readonly board: Board;
  readonly faults: readonly string[];
  memory(name: string): Uint8Array | undefined;
  state(name: string): unknown;
  run(durationPs: number): void;
  dispose(): void;
}

export async function createSpiCircuit(options: SpiCircuitOptions): Promise<SpiCircuit> {
  const mcu = await loadMcu();
  const clock = options.clockFrequency ?? 16_000_000;
  const image = firmwareImage([
    {
      addressSpace: 'code',
      address: 0x0800_0000,
      data: new Uint8Array(options.firmware),
    },
  ]);
  const factory = adaptModelFactory(mcu.create as never, {
    props: {
      clockFrequency: clock,
      firmware: image,
    },
    events: {
      onDidFault: 'fault',
    },
  });
  const faults: string[] = [];
  const board = createBoard(
    createDeviceLibrary([
      {
        id: 'mcu',
        model: mcu.model,
        create: factory as unknown as DeviceFactory,
      },
    ] as never),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { clockFrequency: clock } }],
      nets: [
        {
          id: 'vdd',
          pins: ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'].map((pin) => ({
            instance: 'mcu',
            pin,
          })),
          voltage: 3.3,
        },
        {
          id: 'vss',
          pins: ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'].map((pin) => ({
            instance: 'mcu',
            pin,
          })),
          voltage: 0,
        },
        {
          id: 'loop',
          pins: [
            { instance: 'mcu', pin: 'PA7' },
            { instance: 'mcu', pin: 'PA6' },
          ],
        },
        { id: 'sck', pins: [{ instance: 'mcu', pin: 'PA5' }] },
      ],
    } as never,
  );
  const errorSubscription = board.onDidError((error) => faults.push(error.message));
  const instance = (
    board as unknown as {
      readonly instances?: readonly {
        readonly states?: ReadonlyMap<string, unknown>;
        readonly memories?: ReadonlyMap<string, Uint8Array>;
      }[];
    }
  ).instances?.[0];

  return {
    board,
    faults,
    memory: (name) => instance?.memories?.get(name),
    state: (name) => instance?.states?.get(name),
    run: (durationPs) => board.runUntil(board.time + durationPs),
    dispose: () => {
      errorSubscription.dispose();
      board.dispose();
    },
  };
}
