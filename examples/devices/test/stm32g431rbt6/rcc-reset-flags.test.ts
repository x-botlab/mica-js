import { types } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { RCC_CSR } from '@mica-js/stm32g431rbt6-core/clock-tree';
import {
  readRcc,
  rccResetFlagsForCause,
  recordRccResetFlags,
  writeRcc,
} from '@mica-js/stm32g431rbt6-core/rcc';
import { RESET_CAUSE, RESET_COUNT } from '@mica-js/stm32g431rbt6-core/system-layout';
import { clockRig } from './clock-rig';

const n = (b: Body, value: number) => b.constant(types.number, value);
const readCsr = (b: Body) => readRcc(b, n(b, RCC_CSR), 4);
const save = (b: Body, index: number, value: ReturnType<typeof readCsr>): void =>
  b.writeState(`o${index}`, value);

const FLAG_PIN = 1 << 26;
const FLAG_BOR = 1 << 27;
const FLAG_SFT = 1 << 28;
const FLAG_IWDG = 1 << 29;
const FLAG_WWDG = 1 << 30;

describe('RCC_CSR 复位源标志', () => {
  it('按 reset cause 合成 IWDG/WWDG/SFT/PIN/BOR，不再全部默认 POR', () => {
    expect(rccResetFlagsForCause(1)).toBe(FLAG_PIN);
    expect(rccResetFlagsForCause(2)).toBe(FLAG_SFT);
    expect(rccResetFlagsForCause(3)).toBe(FLAG_SFT);
    expect(rccResetFlagsForCause(5)).toBe(FLAG_IWDG);
    expect(rccResetFlagsForCause(6)).toBe(FLAG_WWDG);
    expect(rccResetFlagsForCause(7)).toBe(FLAG_WWDG);
    expect(rccResetFlagsForCause(8)).toBe(FLAG_BOR);
    expect(rccResetFlagsForCause(0)).toBe(FLAG_PIN | FLAG_BOR);
  });

  it('CSR 读合成当前 cause，RMVF 清除后为 0', () => {
    const rig = clockRig({
      init: (b) => {
        writeWordAt(b, 'sys', RESET_CAUSE, n(b, 5)); // IWDG
        writeWordAt(b, 'sys', RESET_COUNT, n(b, 1));
      },
      emit: (b) => {
        save(b, 0, readCsr(b));
        writeRcc(b, n(b, RCC_CSR), 4, n(b, 1 << 23)); // RMVF
        save(b, 1, readCsr(b));
      },
    });

    try {
      rig.run(1);
      const first = rig.states.get('o0') as number;
      const after = rig.states.get('o1') as number;

      expect(first & FLAG_IWDG).not.toBe(0);
      expect(first & FLAG_PIN).toBe(0);
      expect(first & FLAG_BOR).toBe(0);
      expect(after & 0xfe000000).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('recordRccResetFlags 可累计多源 flags', () => {
    const rig = clockRig({
      init: (b) => {
        writeWordAt(b, 'sys', RESET_CAUSE, n(b, 5));
        writeWordAt(b, 'sys', RESET_COUNT, n(b, 1));
        recordRccResetFlags(b);
        writeWordAt(b, 'sys', RESET_CAUSE, n(b, 6));
        writeWordAt(b, 'sys', RESET_COUNT, n(b, 2));
        recordRccResetFlags(b);
      },
      emit: (b) => save(b, 0, readCsr(b)),
    });

    try {
      rig.run(1);
      const flags = rig.states.get('o0') as number;

      expect(flags & FLAG_IWDG).not.toBe(0);
      expect(flags & FLAG_WWDG).not.toBe(0);
    } finally {
      rig.dispose();
    }
  });
});
