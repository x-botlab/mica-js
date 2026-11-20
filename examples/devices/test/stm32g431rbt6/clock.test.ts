import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { JitTranslate } from '@mica-js/sdk/device';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import {
  apbDivider,
  ahbDivider,
  clockGateEnabled,
  clockConfigKey,
  clockGateResetHeld,
  clockSources,
  HSI_HZ,
  LSE_DEFAULT_HZ,
  LSI_DEFAULT_HZ,
  timerClockHz,
} from '@mica-js/stm32g431rbt6-core/clock-tree';

describe('时钟树静态换算', () => {
  it('实现 AHB/APB 分频与定时器 APB 倍频', () => {
    expect([0, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(ahbDivider)).toEqual([
      1, 1, 2, 4, 8, 16, 64, 128, 256, 512,
    ]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(apbDivider)).toEqual([1, 1, 1, 1, 2, 4, 8, 16]);
    expect(timerClockHz(40_000_000, 0)).toBe(40_000_000);
    expect(timerClockHz(40_000_000, 4)).toBe(80_000_000);
    expect(timerClockHz(20_000_000, 6)).toBe(40_000_000);
  });

  it('HSE 缺省不可用，配置挂在 Machine 实例上', () => {
    const machine: Machine = {
      clockFrequency: 16_000_000,
      cyclePs: 62_500,
      alternateDrivers: [],
      peripherals: [],
      interruptSources: [],
      profile: 'clock-test',
    };
    const withHse = { ...machine, hseFrequency: 24_000_000 } as Machine;

    expect(activateMachine(machine, () => clockSources())).toEqual({
      fallbackHz: 16_000_000,
      hsiHz: HSI_HZ,
      hseHz: 0,
      lseHz: LSE_DEFAULT_HZ,
      lsiHz: LSI_DEFAULT_HZ,
    });
    expect(activateMachine(withHse, () => clockSources()).hseHz).toBe(24_000_000);
    // 两次激活互不影响，不存在进程级覆盖。
    expect(activateMachine(machine, () => clockSources()).hseHz).toBe(0);
    // 中央必须把该指纹纳入 JIT 块缓存键。
    expect(activateMachine(machine, () => clockConfigKey())).not.toBe(
      activateMachine(withHse, () => clockConfigKey()),
    );
  });
});

describe('RCC 门控/复位查询 hook', () => {
  const probeModel = () => {
    const builder = createDeviceBuilder({ name: 'ClockGateProbe' });

    builder.memory({ name: 'periph', length: 0x1000 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    builder.state({ name: 'gate', type: types.number, initial: 0 });
    builder.state({ name: 'reset', type: types.number, initial: 0 });

    return builder.finish();
  };

  const translate: JitTranslate = ({ pc }, block) => {
    block.instruction({ pc, nextPc: pc }, (body) => {
      body.writeState(
        'gate',
        body.select(
          types.number,
          clockGateEnabled(body, 'usart2'),
          (on) => on.constant(types.number, 1),
          (off) => off.constant(types.number, 0),
        ),
      );
      body.writeState(
        'reset',
        body.select(
          types.number,
          clockGateResetHeld(body, 'usart2'),
          (on) => on.constant(types.number, 1),
          (off) => off.constant(types.number, 0),
        ),
      );
      body.stop();
    });

    return block.finish();
  };

  const board = (enabled: boolean, reset: boolean) => {
    const periph = new Uint8Array(0x1000);
    const view = new DataView(periph.buffer);

    if (enabled) view.setUint32(0x58, 1 << 17, true); // APB1ENR1.USART2EN
    if (reset) view.setUint32(0x38, 1 << 17, true); // APB1RSTR1.USART2RST
    const runtime = createBoard(
      createDeviceLibrary([
        {
          id: 'probe',
          model: probeModel(),
          create: (context) => {
            context.attachJit({ entry: 'probe', code: 'periph', pc: 'pc', translate });
            context.loadBytes('periph', periph);

            return { sync() {}, dispose() {} };
          },
        },
      ]),
      { instances: [{ id: 'probe', type: 'probe' }], nets: [] },
    );
    const instance = (
      runtime as unknown as {
        readonly instances: readonly {
          readonly states: ReadonlyMap<string, unknown>;
        }[];
      }
    ).instances[0]!;

    runtime.runUntil(1);

    return {
      states: instance.states,
      dispose: () => runtime.dispose(),
    };
  };

  it('读取真实 RCC 使能位与复位保持位', () => {
    const both = board(true, true);

    try {
      expect(both.states.get('gate')).toBe(1);
      expect(both.states.get('reset')).toBe(1);
    } finally {
      both.dispose();
    }

    const clocked = board(true, false);

    try {
      expect(clocked.states.get('gate')).toBe(1);
      expect(clocked.states.get('reset')).toBe(0);
    } finally {
      clocked.dispose();
    }
  });
});
