import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { adaptModelFactory, firmwareImage } from '@mica-js/sdk/device';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 时钟/PWR 测试夹具：真实器件 + 可选带时间戳的引脚探针。
 *
 * 现有 `harness.ts` 的探针只保留电平；动态时钟验收需要每条消息的仿真时间，因此
 * 这里单独建一个记录 `{time, value}` 的探针器件。板级连接（VDD/VSS、电源网络）
 * 与 `hal-delay.test.ts` 保持一致。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

const PROBE_MODEL = `
device ClockProbe {
  pin p(low: 0.8, high: 2.0);
  output channel level: number(capacity: 256, overflow: Overflow.drop_oldest);
  fn report() {
    if p.sample.level == Logic.high {
      level.send(1);
    } else if p.sample.level == Logic.low {
      level.send(0);
    } else {
      level.send(2);
    }
  }
  process start { report(); }
  reaction changed on p.sample.level as (previous, next) { report(); }
}
`;

export interface Transition {
  readonly time: number;
  readonly value: number;
}

export interface ClockOptions {
  /** 复位后、固件尚未写时钟寄存器时的宿主 CPU 频率。 */
  readonly clockFrequency?: number;
  /**
   * HSE 晶振频率；0/缺省=未焊晶振。需要中央在 DDL/Machine 声明 `hseFrequency`
   * 后才能真正传入；同进程双板 HSE 测试依赖它。
   */
  readonly hseFrequency?: number;
  readonly firmware: Uint8Array;
  readonly pins?: readonly string[];
  readonly execution?: 'throughput' | 'precise';
}

function adaptClockDevice(
  module: { readonly create: unknown },
  options: ClockOptions,
): (context: never) => { sync(batch: never): void; dispose(): void } {
  const image = firmwareImage([
    {
      addressSpace: 'code',
      address: 0x0800_0000,
      data: new Uint8Array(options.firmware),
    },
  ]);
  const props: Record<string, unknown> = {
    clockFrequency: options.clockFrequency ?? 16_000_000,
    firmware: image,
  };

  if (options.hseFrequency !== undefined) props.hseFrequency = options.hseFrequency;

  return adaptModelFactory(module.create as never, {
    props,
    events: {
      onDidUart1Tx: {
        topic: 'serial1.tx',
        transform: (value) => (value as { data: Uint8Array }).data,
      },
      onDidUart2Tx: {
        topic: 'serial2.tx',
        transform: (value) => (value as { data: Uint8Array }).data,
      },
      onDidUart3Tx: {
        topic: 'serial3.tx',
        transform: (value) => (value as { data: Uint8Array }).data,
      },
      onDidFault: 'fault',
    },
  }) as unknown as (context: never) => { sync(batch: never): void; dispose(): void };
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

export interface ClockBoard {
  readonly board: Board;
  readonly transitions: Readonly<Record<string, readonly Transition[]>>;
  readonly topics: Readonly<Record<string, unknown[]>>;
  time(): number;
  memory(name: string): Uint8Array;
  readPeriph(offset: number): number;
  readSram(offset: number): number;
  state(name: string): unknown;
  run(durationPs: number): void;
  dispose(): void;
}

let deviceCache: Promise<{ readonly model: DeviceIR; readonly create: unknown }> | undefined;
let probeCache: Promise<DeviceIR> | undefined;

function loadDevice(): Promise<{ readonly model: DeviceIR; readonly create: unknown }> {
  deviceCache ??= (async () => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
    ]);

    return { model, create: adapter.create };
  })();

  return deviceCache;
}

function probeModel(): Promise<DeviceIR> {
  probeCache ??= compileDDL(PROBE_MODEL);

  return probeCache;
}

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

export async function clockBoard(options: ClockOptions): Promise<ClockBoard> {
  const [device, probe] = await Promise.all([loadDevice(), probeModel()]);
  const pins = options.pins ?? [];
  const transitions: Record<string, Transition[]> = {};
  const mcuProps: Record<string, unknown> = {
    clockFrequency: options.clockFrequency ?? 16_000_000,
  };

  if (options.hseFrequency !== undefined) mcuProps.hseFrequency = options.hseFrequency;
  const instances: object[] = [{ id: 'mcu', type: 'mcu', props: mcuProps }];
  const entries: object[] = [
    {
      id: 'mcu',
      model: device.model,
      create: adaptClockDevice(device, options) as never,
    },
  ];
  const nets: object[] = [
    {
      id: 'vdd',
      voltage: 3.3,
      pins: VDD.map((pin) => ({ instance: 'mcu', pin })),
    },
    {
      id: 'vss',
      voltage: 0,
      pins: VSS.map((pin) => ({ instance: 'mcu', pin })),
    },
  ];

  for (const pin of pins) {
    entries.push({
      id: `probe_${pin}`,
      model: probe,
      create: () => ({
        sync(batch: {
          readonly outputs: Readonly<Record<string, readonly { time: number; value: unknown }[]>>;
        }) {
          const messages = batch.outputs.level ?? [];

          for (const message of messages)
            (transitions[pin] ??= []).push({ time: message.time, value: message.value as number });
        },
        dispose() {},
      }),
    });
    instances.push({ id: `probe_${pin}`, type: `probe_${pin}` });
    nets.push({
      id: pin,
      pins: [
        { instance: 'mcu', pin },
        { instance: `probe_${pin}`, pin: 'p' },
      ],
    });
  }

  const board = createBoard(createDeviceLibrary(entries as never), { instances, nets } as never, {
    execution: options.execution ?? 'throughput',
  });
  const instance = (board as unknown as { readonly instances: readonly InstanceView[] })
    .instances[0]!;
  const topics: Record<string, unknown[]> = {};
  const subscription = board.topics.onDidReceive((message) => {
    (topics[message.topic] ??= []).push(message.payload);
  });

  board.runUntil(0);

  const memory = (name: string): Uint8Array => instance.memories.get(name) ?? new Uint8Array(0);
  const word = (name: string, offset: number): number => {
    const bytes = memory(name);

    return (
      ((bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)) >>>
      0
    );
  };

  return {
    board,
    transitions,
    topics,
    time: () => board.time,
    memory,
    readPeriph: (offset) => word('periph', offset),
    readSram: (offset) => word('sram', offset),
    state: (name) => instance.states.get(name),
    run: (durationPs) => board.runUntil(board.time + durationPs),
    dispose: () => {
      subscription.dispose();
      board.dispose();
    },
  };
}
