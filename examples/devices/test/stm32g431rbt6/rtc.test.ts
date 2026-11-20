import { describe, expect, it } from 'vitest';
import { num } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import {
  advanceRtc,
  readRtc,
  rtcAlarmPending,
  rtcWakePending,
  writeRtc,
} from '@mica-js/stm32g431rbt6-core/rtc';
import { runRig } from './peripheral-rig';
import { applyReset } from '@mica-js/stm32g431rbt6-core/reset';

const NUMBERS = [
  'tr',
  'dr',
  'trAfter',
  'drAfter',
  'ssrBefore',
  'ssrAfter',
  'icrsAfterInit',
  'misr',
  'trProtected',
  'alarmSr',
  'alarmReg',
  'alarmSrBefore',
  'alarmSrAfter',
  'trAfterAlarm',
  'rtcAfterReset',
].map((name) => ({ name, type: 'number' as const, initial: 0 }));
const BOOLS = ['alarmPending', 'wakePending'].map((name) => ({
  name,
  type: 'bool' as const,
  initial: false,
}));

const TR = 0x00;
const DR = 0x04;
const SSR = 0x08;
const ICSR = 0x0c;
const PRER = 0x10;
const WUTR = 0x14;
const CR = 0x18;
const WPR = 0x24;
const ALRMAR = 0x40;
const SR = 0x50;
const MISR = 0x54;
const SCR = 0x5c;

const write = (b: Body, offset: number, value: number): void => {
  writeRtc(b, num(b, offset), 4, num(b, value));
};
const capture = (b: Body, offset: number, state: string): void => {
  b.writeState(state, readRtc(b, num(b, offset), 4));
};
const unlock = (b: Body): void => {
  write(b, WPR, 0xca);
  write(b, WPR, 0x53);
};
const init = (b: Body, tr: number, dr: number, prer = 0x007f00ff): void => {
  unlock(b);
  write(b, ICSR, 0x80);
  write(b, PRER, prer);
  write(b, TR, tr);
  write(b, DR, dr);
  write(b, ICSR, 0x00);
};

describe('STM32G431 RTC', () => {
  it('keeps writes protected until the two-key sequence and INIT mode', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        write(b, TR, 0x123456);
        capture(b, TR, 'trProtected');
        unlock(b);
        write(b, ICSR, 0x80);
        capture(b, ICSR, 'icrsAfterInit');
        write(b, PRER, 0x007f00ff);
        write(b, TR, 0x123456);
        write(b, DR, 0x00245231);
        write(b, ICSR, 0x00);
        capture(b, TR, 'tr');
        capture(b, DR, 'dr');
      },
    });

    try {
      expect(rig.state('trProtected')).toBe(0);
      expect((rig.state('icrsAfterInit') as number) & 0xc0).toBe(0xc0);
      expect(rig.state('tr')).toBe(0x123456);
      expect(rig.state('dr')).toBe(0x00245231);
    } finally {
      rig.dispose();
    }
  });

  it('advances BCD calendar across midnight with virtual time only', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        init(b, 0x235959, 0x00245231);
        advanceRtc(b, num(b, 1_000_000_000_000));
        capture(b, TR, 'trAfter');
        capture(b, DR, 'drAfter');
      },
    });

    try {
      expect(rig.state('trAfter')).toBe(0x000000);
      expect(rig.state('drAfter')).toBe(0x00256101);
    } finally {
      rig.dispose();
    }
  });

  it('matches Alarm A and clears it through SCR', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        init(b, 0x123456, 0x00245231);
        unlock(b);
        write(b, ALRMAR, 0x80808057); // 仅比较秒=57
        capture(b, ALRMAR, 'alarmReg');
        write(b, CR, 0x1100); // ALRAE | ALRAIE
        advanceRtc(b, num(b, 1_000_000_000_000));
        capture(b, TR, 'trAfterAlarm');
        capture(b, SR, 'alarmSrBefore');
        capture(b, MISR, 'misr');
        b.writeState('alarmPending', rtcAlarmPending(b));
        write(b, SCR, 0x01);
        capture(b, SR, 'alarmSrAfter');
      },
    });

    try {
      expect((rig.state('alarmSrBefore') as number) & 1).toBe(1);
      expect((rig.state('misr') as number) & 1).toBe(1);
      expect(rig.state('alarmPending')).toBe(true);
      expect((rig.state('alarmSrAfter') as number) & 1).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('runs the wakeup timer from virtual RTC ticks', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        init(b, 0x123456, 0x00245231);
        unlock(b);
        write(b, WUTR, 1);
        write(b, CR, 0x4404); // WUTE|WUTIE|WUCKSEL=ck_spre
        advanceRtc(b, num(b, 1_000_000_000_000));
        capture(b, TR, 'trAfterAlarm');
        capture(b, SR, 'alarmSr');
        b.writeState('wakePending', rtcWakePending(b));
      },
    });

    try {
      expect((rig.state('alarmSr') as number) & 4).toBe(4);
      expect(rig.state('wakePending')).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('preserves the backup-domain calendar across a system reset', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        init(b, 0x123456, 0x00245231);
        applyReset(b);
        capture(b, TR, 'rtcAfterReset');
      },
    });

    try {
      expect(rig.state('rtcAfterReset')).toBe(0x123456);
    } finally {
      rig.dispose();
    }
  });

  it('reports SSR from the synchronous prescaler', () => {
    const rig = runRig({
      states: [...NUMBERS, ...BOOLS],
      build: (b) => {
        init(b, 0x000000, 0x00240101);
        capture(b, SSR, 'ssrBefore');
        advanceRtc(b, num(b, 500_000_000_000));
        capture(b, SSR, 'ssrAfter');
      },
    });

    try {
      expect(rig.state('ssrBefore')).toBe(255);
      expect(rig.state('ssrAfter')).toBe(127);
    } finally {
      rig.dispose();
    }
  });
});
