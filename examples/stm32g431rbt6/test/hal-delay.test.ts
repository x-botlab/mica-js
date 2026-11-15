import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { describe, expect, it } from 'vitest';

const DEVICE_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'stm32g431rbt6');
const FIRMWARE = join(
  import.meta.dirname,
  '..',
  '..',
  'ili9325',
  'test',
  'fixtures',
  'HAL_06_LCD.bin',
);
const CLOCK = 80_000_000;
/** 与发布基准相同：先越过时钟/外设初始化，再比较一段包含真实 HAL_Delay 的窗口。 */
const COLD_PS = 200_000_000;
const CHECKPOINT_PS = 20_000_000_000;
const SLICE_PS = 1_000_000_000;

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

interface Adapter {
  sync(batch: unknown): void;
  dispose(): void;
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
  readonly host: { write(name: string, value: unknown): void };
  syncCall(name: string, args?: readonly unknown[]): unknown;
}

interface JitView {
  readonly direct?: unknown;
  readonly polling: ReadonlyMap<number, unknown>;
}

const firmware = new Uint8Array(readFileSync(FIRMWARE));
const model = await compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
  uri: 'mica:devices/stm32g431rbt6/model.ddl',
});
const module = (await import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href)) as {
  default: (context: never) => Adapter;
};

function bareBoard(execution: 'throughput' | 'precise'): Board {
  return createBoard(
    createDeviceLibrary([{ id: 'mcu', model, create: module.default as never }]),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { firmware, clockFrequency: CLOCK } }],
      nets: [
        { id: 'vdd', voltage: 3.3, pins: VDD.map((pin) => ({ instance: 'mcu', pin })) },
        { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
      ],
    },
    { execution },
  );
}

function checkpoint(execution: 'throughput' | 'precise') {
  const board = bareBoard(execution);
  board.runUntil(0);
  board.runUntil(COLD_PS);
  while (board.time < CHECKPOINT_PS) board.runUntil(Math.min(board.time + SLICE_PS, CHECKPOINT_PS));

  const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;

  return {
    board,
    instance,
    pc: instance.states.get('pc'),
    sram: new Uint8Array(instance.memories.get('sram')!),
    periph: new Uint8Array(instance.memories.get('periph')!),
  };
}

describe('HAL_Delay time-event polling', () => {
  it('throughput reaches the same firmware checkpoint as precise at 20 ms', () => {
    const precise = checkpoint('precise');
    const throughput = checkpoint('throughput');

    try {
      const jit = (throughput.board as unknown as { jits?: readonly { direct?: unknown }[] })
        .jits?.[0] as JitView | undefined;
      expect(jit?.direct).not.toBeUndefined();
      expect([...jit!.polling.keys()].sort((left, right) => left - right)).toEqual([
        0x28c, 0x0800_028c,
      ]);
      expect(throughput.board.status).toBe('ready');
      expect(throughput.pc).toBe(precise.pc);
      // Compare program globals, not stale stack words below SP: precise and throughput are
      // allowed to differ in dead stack contents while the architectural state matches.
      expect(throughput.sram.subarray(0, 0x200)).toEqual(precise.sram.subarray(0, 0x200));
      expect(throughput.periph).toEqual(precise.periph);
    } finally {
      precise.board.dispose();
      throughput.board.dispose();
    }
  });

  it('keeps SysTick pending under PRIMASK and only wakes through SERVICE_TICK when allowed', () => {
    const board = bareBoard('throughput');

    try {
      board.runUntil(0);
      const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;
      const pc = 0x0800_0100;

      for (const [name, value] of Object.entries({
        pc,
        primask: 1,
        systickOn: true,
        systickCtrl: 2,
        systickLoad: 3,
        systickVal: 0,
        systickPending: 0,
        tickPs: 100,
        pendingPs: 0,
        txMask: 0,
        serviceMask: 0,
        irqDirty: false,
        pollContinue: false,
      }))
        instance.host.write(name, value);

      expect(instance.syncCall('halDelayPoll')).toBe(false);
      instance.host.write('txMask', 1);
      expect(instance.syncCall('halDelayPoll')).toBe(true);
      instance.host.write('txMask', 0);
      instance.host.write('systickOn', false);
      expect(instance.syncCall('halDelayPoll')).toBe(true);
      instance.host.write('systickOn', true);
      instance.host.write('serviceMask', 16);
      expect(instance.syncCall('halDelayPoll')).toBe(true);
      instance.host.write('serviceMask', 0);
      instance.host.write('pollContinue', true);
      expect(instance.syncCall('halDelayPoll')).toBe(true);
      instance.host.write('pollContinue', false);

      instance.syncCall('halDelayAdvance', [100]);
      expect(instance.states.get('systickPending')).toBe(1);
      expect(instance.states.get('irqDirty')).toBe(true);
      expect(instance.states.get('serviceMask')).toBe(0);
      expect(instance.states.get('pc')).toBe(pc);
      expect(instance.states.get('pollContinue')).toBe(false);

      instance.host.write('primask', 0);
      instance.syncCall('halDelayAdvance', [100]);
      expect(instance.states.get('serviceMask')).toBe(16);
      expect(instance.states.get('serviceResume')).toBe(pc);
      expect(instance.states.get('pc')).toBe(0x20000);
      expect(instance.states.get('pollContinue')).toBe(true);
    } finally {
      board.dispose();
    }
  });
});
