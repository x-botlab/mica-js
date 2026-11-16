import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '@mica-js/sdk/device';
import type { DeviceContext, JitTranslate } from '@mica-js/sdk/device';
import {
  assembleFrames,
  instance as findInstance,
  JOINT_CLOCK_FREQUENCY,
  JOINT_TIME_QUANTUM_PS,
  type JointBoard,
  type JointInstance,
} from './joint-harness';
import { fuseBlock, loadFusedModel, FUSED_FRAME_PC, FUSED_FRAME_BLOCK } from './fused-model';

let modulesPromise:
  | Promise<{ mcu: { create: unknown }; lcd: { create: unknown } }>
  | undefined;

function loadModules(): Promise<{ mcu: { create: unknown }; lcd: { create: unknown } }> {
  modulesPromise ??= Promise.all([
    import(
      pathToFileURL(join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src', 'index.ts')).href
    ),
    import(
      pathToFileURL(join(import.meta.dirname, '..', '..', 'ili9325', 'src', 'index.ts')).href
    ),
  ]).then(([mcu, lcd]) => ({
    mcu: mcu as { create: unknown },
    lcd: lcd as { create: unknown },
  }));

  return modulesPromise;
}

/** The two views share one instance; there is only one JIT and no external bus wiring. */
export async function createFusedBoard(
  options: { firmware?: Uint8Array; translate?: JitTranslate } = {},
): Promise<JointBoard> {
  const model = await loadFusedModel();
  const { mcu: mcuModule, lcd: lcdModule } = await loadModules();
  const translate = options.translate;
  const frames: Uint8Array[] = [];
  const frameTimes: number[] = [];
  const expectedFrames: Uint8Array[] = [];
  const faults: number[] = [];
  const errors: string[] = [];
  const firmware = firmwareImage([
    {
      addressSpace: 'code',
      address: 0x0800_0000,
      data:
        options.firmware?.slice() ??
        new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures/HAL_06_LCD.bin'))),
    },
  ]);
  const mcuCreate = adaptModelFactory(mcuModule.create as never, {
    props: {
      clockFrequency: JOINT_CLOCK_FREQUENCY,
      firmware,
    },
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
  }) as unknown as (context: DeviceContext) => {
    sync(batch: unknown): void;
    dispose(): void;
  };
  const lcdCreate = adaptModelFactory(lcdModule.create as never, {
    events: {
      onDidFrame: {
        topic: 'framebuffer',
        transform: (value) => {
          const frame = value as {
            readonly x: number;
            readonly y: number;
            readonly width: number;
            readonly height: number;
            readonly pixels: Uint8Array;
          };
          const payload = new Uint8Array(8 + frame.pixels.length);
          const header = new DataView(payload.buffer);

          header.setUint16(0, frame.x, true);
          header.setUint16(2, frame.y, true);
          header.setUint16(4, frame.width, true);
          header.setUint16(6, frame.height, true);
          payload.set(frame.pixels, 8);

          return payload;
        },
      },
    },
  }) as unknown as (context: DeviceContext) => {
    sync(batch: unknown): void;
    dispose(): void;
  };
  const board = createBoard(
    createDeviceLibrary([
      {
        id: 'fused',
        model,
        create(context: DeviceContext) {
          const fusedContext = {
            ...context,
            attachJit(options: Parameters<DeviceContext['attachJit']>[0]) {
              return context.attachJit({
                ...options,
                translate: (input, builder) =>
                  input.pc === FUSED_FRAME_PC
                    ? FUSED_FRAME_BLOCK
                    : fuseBlock((translate ?? options.translate)(input, builder), model),
              });
            },
          };
          const mcu = mcuCreate(fusedContext as never);
          const lcd = lcdCreate(context as never);
          return {
            sync(batch: {
              readonly outputs: Readonly<
                Record<string, readonly { readonly value: unknown; readonly time: number }[]>
              >;
            }) {
              expectedFrames.push(...assembleFrames(batch.outputs));
              frameTimes.push(...(batch.outputs.frameInfo ?? []).map((info) => info.time));
              mcu.sync(batch);
              lcd.sync(batch);
            },
            dispose() {
              mcu.dispose();
              lcd.dispose();
            },
          };
        },
      },
    ]),
    {
      instances: [
        {
          id: 'fused',
          type: 'fused',
          props: {
            firmware:
              options.firmware?.slice() ??
              new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures/HAL_06_LCD.bin'))),
            clockFrequency: JOINT_CLOCK_FREQUENCY,
            refreshRate: 60,
          },
        },
      ],
      nets: [
        { id: 'vdd', voltage: 3.3, pins: [{ instance: 'fused', pin: 'VDD1' }] },
        { id: 'vss', voltage: 0, pins: [{ instance: 'fused', pin: 'VSS1' }] },
      ],
    },
  );
  const instance = findInstance(
    (board as unknown as { instances: readonly (JointInstance & { id: string })[] }).instances,
    'fused',
  );
  if (!instance) {
    board.dispose();
    throw new Error('Missing fused device instance');
  }
  const subscription = board.topics.onDidReceive((message) => {
    if (message.topic === 'framebuffer') frames.push(message.payload as Uint8Array);
    else if (message.topic === 'fault') faults.push(message.payload as number);
  });
  const diagnostic = board.onDidError((error) => errors.push(`${error.code}: ${error.message}`));
  return {
    board,
    frames,
    frameTimes,
    expectedFrames,
    faults,
    errors,
    mcu: instance,
    lcd: instance,
    advanceTo(targetPs) {
      while (board.time < targetPs) {
        const previous = board.time;
        try {
          board.runUntil(Math.min(previous + JOINT_TIME_QUANTUM_PS, targetPs));
        } catch (cause) {
          throw new Error(
            `fused failure at ${board.time} ps pc=${instance.states.get('pc')} frameDelay=${instance.states.get('fusedFrameDelay')} pending=${instance.states.get('fusedFramePending')}`,
            { cause },
          );
        }
        if (board.status !== 'ready' || errors.length || faults.length || board.time === previous)
          throw new Error(
            `fused board stopped at ${board.time} ps: ${errors.join('; ')} faults=${faults}`,
          );
      }
    },
    readAccounting: () => undefined,
    dispose() {
      subscription.dispose();
      diagnostic.dispose();
      board.dispose();
    },
  };
}
