import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { DeviceContext, JitTranslate } from '@mica-js/sdk/device';
import createMcu from '../../src/devices/stm32g431rbt6/index';
import createLcd from '../../src/devices/ili9325/index';
import {
  assembleFrames,
  instance as findInstance,
  JOINT_CLOCK_FREQUENCY,
  JOINT_TIME_QUANTUM_PS,
  type JointBoard,
  type JointInstance,
} from './joint-harness';
import { fuseBlock, loadFusedModel, FUSED_FRAME_PC, FUSED_FRAME_BLOCK } from './fused-model';

/** The two views share one instance; there is only one JIT and no external bus wiring. */
export async function createFusedBoard(
  options: { firmware?: Uint8Array; translate?: JitTranslate } = {},
): Promise<JointBoard> {
  const model = await loadFusedModel();
  const translate = options.translate;
  const frames: Uint8Array[] = [];
  const frameTimes: number[] = [];
  const expectedFrames: Uint8Array[] = [];
  const faults: number[] = [];
  const errors: string[] = [];
  const board = createBoard(
    createDeviceLibrary([
      {
        id: 'fused',
        model,
        create(context: DeviceContext) {
          const mcu = createMcu({
            ...context,
            attachJit(options) {
              return context.attachJit({
                ...options,
                translate: (input, builder) =>
                  input.pc === FUSED_FRAME_PC
                    ? FUSED_FRAME_BLOCK
                    : fuseBlock((translate ?? options.translate)(input, builder), model),
              });
            },
          } as Parameters<typeof createMcu>[0]);
          const lcd = createLcd(context as Parameters<typeof createLcd>[0]);
          return {
            sync(batch: Parameters<typeof mcu.sync>[0] & Parameters<typeof lcd.sync>[0]) {
              expectedFrames.push(...assembleFrames(batch.outputs));
              frameTimes.push(...batch.outputs.frameInfo.map((info) => info.time));
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
