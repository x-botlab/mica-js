import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { describe, expect, it } from 'vitest';
import { adaptDevice } from './harness';

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');
const FIXTURES = join(import.meta.dirname, 'fixtures');
const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

const model = await compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
  uri: 'mica:devices/stm32g431rbt6/model.ddl',
});
const module = (await import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href)) as {
  create: unknown;
};

describe('STM32G431RBT6 USART 空闲开销', () => {
  it('没有启用 RX 时 txMask 保持为零，RX 采样状态不被触碰', () => {
    const firmware = new Uint8Array(readFileSync(join(FIXTURES, 'gpio-blink.bin')));
    const board = createBoard(
      createDeviceLibrary([
        {
          id: 'mcu',
          model,
          create: adaptDevice(module, { firmware, clockFrequency: 16_000_000 }) as never,
        },
      ]),
      {
        instances: [{ id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } }],
        nets: [
          { id: 'vdd', voltage: 3.3, pins: VDD.map((pin) => ({ instance: 'mcu', pin })) },
          { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
        ],
      },
    );
    const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;

    try {
      board.runUntil(10_000_000);
      expect(instance.states.get('txMask')).toBe(0);
      expect(instance.states.get('tickActive')).toBe(false);
      const periph = instance.memories.get('periph')!;

      for (const offset of [0xcc0, 0xcc4, 0xcc8, 0xccc]) {
        expect(periph[offset], `RX state at 0x${offset.toString(16)}`).toBe(0);
      }
    } finally {
      board.dispose();
    }
  });
});
