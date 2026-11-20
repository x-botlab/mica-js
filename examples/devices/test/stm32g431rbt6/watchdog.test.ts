import { describe, expect, it } from 'vitest';
import { types } from '@mica-js/sdk/model';
import { asBody, num } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { IWDG_BASE, SYS, WWDG_BASE } from '@mica-js/stm32g431rbt6-core/layout';
import { RESET_CAUSE, RESET_COUNT, RESET_REQUEST } from '@mica-js/stm32g431rbt6-core/system-layout';
import { applyPendingReset } from '@mica-js/stm32g431rbt6-core/reset';
import {
  advanceWatchdogs,
  readWatchdogAddress,
  wwdgPending,
  writeWatchdogAddress,
} from '@mica-js/stm32g431rbt6-core/watchdog';
import { runRig } from './peripheral-rig';

const NUMBERS = [
  'pr',
  'rlr',
  'sr',
  'srAfter',
  'cr',
  'reserved',
  'srEarly',
  'srKeep',
  'srClear',
  'pcAfter',
  'resetCount',
  'resetCause',
].map((name) => ({ name, type: 'number' as const, initial: 0 }));
const BOOLS = ['ewi', 'reset', 'resetBefore', 'resetAt'].map((name) => ({
  name,
  type: 'bool' as const,
  initial: false,
}));

const resetPending = (b: Body) =>
  b.notEqual(types.number, b.load32le(SYS, num(b, RESET_REQUEST)), num(b, 0));

const iwdgWrite = (b: Body, offset: number, value: number): void => {
  writeWatchdogAddress(b, num(b, IWDG_BASE + offset), 4, num(b, value));
};
const iwdgRead = (b: Body, offset: number, state: string): void => {
  b.writeState(state, readWatchdogAddress(b, num(b, IWDG_BASE + offset), 4));
};
const wwdgWrite = (b: Body, offset: number, value: number): void => {
  writeWatchdogAddress(b, num(b, WWDG_BASE + offset), 4, num(b, value));
};
const wwdgRead = (b: Body, offset: number, state: string): void => {
  b.writeState(state, readWatchdogAddress(b, num(b, WWDG_BASE + offset), 4));
};

function manySmallAdvances(b: Body, count: number, stepPs: number): void {
  const remaining = b.local(types.number, count);

  b.loop((loop) => {
    const body = asBody(loop);

    body.if(
      body.lessThanOrEqual(body.getLocal(remaining), num(body, 0)),
      (done) => done.break(),
      (step) => {
        const inner = asBody(step);

        advanceWatchdogs(inner, num(inner, stepPs));
        inner.setLocal(
          remaining,
          inner.subtract(inner.getLocal(remaining), inner.constant(types.number, 1)),
        );
      },
    );
  });
}

describe('STM32G431 watchdog', () => {
  it('uses (RLR+1) ticks, clamps PR=7 to /256 and clears update flags with small ticks', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        iwdgRead(b, 0x04, 'pr');
        iwdgRead(b, 0x08, 'rlr');
        iwdgWrite(b, 0x08, 0x100); // 未解锁，忽略
        iwdgRead(b, 0x08, 'rlr');
        iwdgWrite(b, 0x00, 0x5555);
        iwdgWrite(b, 0x04, 7);
        iwdgWrite(b, 0x08, 0);
        iwdgRead(b, 0x0c, 'sr');
        // 大量 10 ns tick，累计 200 µs 后更新位必须清除。
        manySmallAdvances(b, 20_000, 10_000);
        iwdgRead(b, 0x0c, 'srAfter');
        iwdgWrite(b, 0x00, 0xcccc);
        // RLR=0 仍有 1 个 tick；/256 时周期 = 8 ms，/512 会是 16 ms。
        advanceWatchdogs(b, num(b, 1_000_000_000));
        b.writeState('resetBefore', resetPending(b));
        advanceWatchdogs(b, num(b, 7_500_000_000));
        b.writeState('resetAt', resetPending(b));
      },
    });

    try {
      expect(rig.state('pr')).toBe(0);
      expect(rig.state('rlr')).toBe(0xfff);
      expect(rig.state('sr')).toBe(0x3);
      expect(rig.state('srAfter')).toBe(0);
      expect(rig.state('resetBefore')).toBe(false);
      expect(rig.state('resetAt')).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('matches one large advance and 10000 small advances at the 100 ms boundary', () => {
    const runLarge = (): unknown => {
      const rig = runRig({
        states: [...NUMBERS, ...BOOLS],
        build: (b) => {
          iwdgWrite(b, 0x00, 0x5555);
          iwdgWrite(b, 0x04, 0);
          iwdgWrite(b, 0x08, 799); // (799+1)*4/32000 = 100 ms
          iwdgWrite(b, 0x00, 0xcccc);
          advanceWatchdogs(b, num(b, 99_000_000_000));
          b.writeState('resetBefore', resetPending(b));
          advanceWatchdogs(b, num(b, 1_000_000_000));
          b.writeState('reset', resetPending(b));
        },
      });

      try {
        return [rig.state('resetBefore'), rig.state('reset')];
      } finally {
        rig.dispose();
      }
    };

    const runSmall = (): unknown => {
      const rig = runRig({
        states: [...NUMBERS, ...BOOLS],
        build: (b) => {
          iwdgWrite(b, 0x00, 0x5555);
          iwdgWrite(b, 0x04, 0);
          iwdgWrite(b, 0x08, 799);
          iwdgWrite(b, 0x00, 0xcccc);
          manySmallAdvances(b, 9_900, 10_000_000);
          b.writeState('resetBefore', resetPending(b));
          manySmallAdvances(b, 100, 10_000_000);
          b.writeState('reset', resetPending(b));
        },
      });

      try {
        return [rig.state('resetBefore'), rig.state('reset')];
      } finally {
        rig.dispose();
      }
    };

    expect(runLarge()).toEqual([false, true]);
    expect(runSmall()).toEqual([false, true]);
  });

  it('triggers the IWDG window reset when reloaded too early', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        iwdgWrite(b, 0x00, 0x5555);
        iwdgWrite(b, 0x08, 0x100);
        iwdgWrite(b, 0x10, 0x80);
        iwdgWrite(b, 0x00, 0xcccc);
        iwdgWrite(b, 0x00, 0xaaaa);
        b.writeState('reset', resetPending(b));
      },
    });

    try {
      expect(rig.state('reset')).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('keeps WWDG running after WDGA is written 0 and refreshes from the old counter', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        wwdgWrite(b, 0x04, 0x50 | 0x200);
        wwdgWrite(b, 0x00, 0x80 | 0x7f);
        advanceWatchdogs(b, num(b, 16_128_000_000)); // counter reaches 0x40
        wwdgRead(b, 0x08, 'srEarly');
        b.writeState('ewi', wwdgPending(b));
        // 写 1 保持 EWIF。
        wwdgWrite(b, 0x08, 1);
        wwdgRead(b, 0x08, 'srKeep');
        // 写 0 清 EWIF。
        wwdgWrite(b, 0x08, 0);
        wwdgRead(b, 0x08, 'srClear');
        // 当前 counter=0x40 <= W=0x50，刷新合法；旧代码会因新 T>W 误复位。
        wwdgWrite(b, 0x00, 0x80 | 0x7f);
        b.writeState('resetBefore', resetPending(b));
        // 等 counter 进入窗口后尝试 WDGA=0 停狗：必须被忽略并继续刷新。
        advanceWatchdogs(b, num(b, 12_032_000_000));
        wwdgWrite(b, 0x00, 0x50);
        wwdgRead(b, 0x00, 'cr');
        b.writeState('reset', resetPending(b));
      },
    });

    try {
      expect(rig.state('srEarly')).toBe(1);
      expect(rig.state('srKeep')).toBe(1); // 写 1 保持 rc_w0 位
      expect(rig.state('srClear')).toBe(0); // 写 0 清零
      expect(rig.state('ewi')).toBe(true);
      expect(rig.state('resetBefore')).toBe(false);
      expect(rig.state('cr')).toBe(0x80 | 0x50);
      expect(rig.state('reset')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('resets on an early WWDG refresh and when the window expires', () => {
    const early = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        wwdgWrite(b, 0x04, 0x50);
        wwdgWrite(b, 0x00, 0x80 | 0x7f);
        wwdgWrite(b, 0x00, 0x80 | 0x7f); // 当前 0x7f > W，提前刷新
        b.writeState('reset', resetPending(b));
      },
    });
    const expired = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        wwdgWrite(b, 0x04, 0x50);
        wwdgWrite(b, 0x00, 0x80 | 0x50);
        advanceWatchdogs(b, num(b, 5_000_000_000));
        b.writeState('reset', resetPending(b));
      },
    });

    try {
      expect(early.state('reset')).toBe(true);
      expect(expired.state('reset')).toBe(true);
    } finally {
      early.dispose();
      expired.dispose();
    }
  });

  it('feeds the existing reset sink and reloads the vector with cause/count', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        b.store32le('code', num(b, 0), num(b, 0x20005800));
        b.store32le('code', num(b, 4), num(b, 0x08000101));
        iwdgWrite(b, 0x00, 0x5555);
        iwdgWrite(b, 0x04, 7);
        iwdgWrite(b, 0x08, 0);
        iwdgWrite(b, 0x00, 0xcccc);
        advanceWatchdogs(b, num(b, 8_500_000_000));
        b.writeState('resetBefore', resetPending(b));
        applyPendingReset(b);
        b.writeState('pcAfter', b.readState('pc', types.number));
        b.writeState('resetCount', b.load32le(SYS, num(b, RESET_COUNT)));
        b.writeState('resetCause', b.load32le(SYS, num(b, RESET_CAUSE)));
      },
    });

    try {
      expect(rig.state('resetBefore')).toBe(true);
      expect(rig.state('pcAfter')).toBe(0x08000100);
      expect(rig.state('resetCount')).toBe(1);
      expect(rig.state('resetCause')).toBe(5);
    } finally {
      rig.dispose();
    }
  });

  it('does not alias reserved watchdog offsets onto PR/CR', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        iwdgWrite(b, 0x00, 0x5555);
        iwdgWrite(b, 0x04, 3);
        iwdgRead(b, 0x04, 'pr');
        iwdgRead(b, 0x44, 'reserved');
        iwdgWrite(b, 0x44, 7);
        iwdgRead(b, 0x04, 'pr');
      },
    });

    try {
      expect(rig.state('pr')).toBe(3);
      expect(rig.state('reserved')).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});
