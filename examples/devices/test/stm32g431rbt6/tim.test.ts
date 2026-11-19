import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import {
  TIMERS,
  advanceTimers,
  isTimerCaptureArmedOnPin,
  observeTimerInputByPin,
  timerCaptureGateDescriptors,
  timerChannelActive,
  timerChannelLevel,
  timerDrivers,
  timerIrqPending,
} from '@mica-js/stm32g431rbt6-core/tim';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import {
  ARR,
  BDTR,
  TIM1,
  CCR1,
  CCMR1,
  CCER,
  CNT,
  CR1,
  CR1_ARPE,
  CR1_CEN,
  DIER,
  DIER_CC1IE,
  DIER_UIE,
  EGR,
  EGR_UG,
  PSC,
  SR,
  SR_CC1IF,
  SR_UIF,
  TIM2,
  TIM3,
  TIM6,
  TIM16,
  RCR,
  CR1_OPM,
  timerRead,
  timerWrite,
  createTimRig,
  disableClock,
  enableClock,
  setClockReset,
} from './tim-rig';

/**
 * TIM 核心的最小行为链：32/16 位计数与溢出 → 预装载 → 输入捕获 → PWM → IRQ。
 *
 * 这些用例走 `tim-rig` 的真实 simulator 板，不经过宿主直接写 CCR；输入边沿来自真实
 * `PA15`/`PB4` 引脚 sample，PWM 输出经 25 Ω 有限电阻驱动 `PA0` 并由探针观察。中央
 * 完成 bus/GPIO/NVIC/DDL 接线后，同一组断言可以复制到真实 MCU 固件路径。
 */

const num = (b: Body, value: number) => b.constant(types.number, value);
const bool = (b: Body, value: boolean) => b.constant(types.bool, value);
const state = (b: Body, name: string) => b.readState(name, types.number);
const write = (b: Body, name: string, value: number | ReturnType<Body['constant']>): void =>
  b.writeState(name, typeof value === 'number' ? num(b, value) : value);
const boolNumberAt = (b: Body, name: string, value: Value<boolean>): void =>
  b.writeState(
    name,
    b.select(
      types.number,
      value,
      (yes) => yes.constant(types.number, 1),
      (no) => no.constant(types.number, 0),
    ),
  );

const boolNumber = (b: Body, value: Value<boolean>): void => boolNumberAt(b, 'result3', value);

describe('STM32G431 TIM core', () => {
  it('TIM2 32 位计数跨过 0xFFFFFFFF 并置 UIF/IRQ', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 0xffffffff);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CNT, 0xfffffffe);
      timerWrite(body, TIM2, DIER, DIER_UIE);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 2_000_000);
    };
    const inspect: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM2, CNT));
      write(body, 'result1', timerRead(body, TIM2, SR));
      boolNumber(body, timerIrqPending(body, 28));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, inspect] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_100_000);

      expect(rig.state('result0')).toBe(0);
      expect(Number(rig.state('result1')) & SR_UIF).toBe(SR_UIF);
      expect(rig.state('result3')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('复位后 TIM2/TIM3 的 ARR 位宽分别是 32/16 位，CNT/CR1 为零', async () => {
    const inspect: (body: Body) => void = (body) => {
      write(body, 'result0', timerRead(body, TIM2, ARR));
      write(body, 'result1', timerRead(body, TIM3, ARR));
      write(body, 'result2', timerRead(body, TIM3, CNT));
      write(body, 'result4', timerRead(body, TIM3, CR1));
      body.stop();
    };
    const rig = await createTimRig({ steps: [inspect] });

    try {
      rig.runUntil(1);

      expect(rig.state('result0')).toBe(0xffffffff);
      expect(rig.state('result1')).toBe(0xffff);
      expect(rig.state('result2')).toBe(0);
      expect(rig.state('result4')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('PSC 预装载在 UG 后生效：1 MHz 时钟、PSC=1 时 10 µs 只前进 5 个计数', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 0xffffffff);
      timerWrite(body, TIM2, PSC, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      timerWrite(body, TIM2, EGR, EGR_UG);
      body.redirect(2, 10_000_000);
    };
    const inspect: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM2, CNT));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, inspect] });

    try {
      rig.runUntil(0);
      rig.runUntil(10_100_000);

      expect(rig.state('result0')).toBe(5);
    } finally {
      rig.dispose();
    }
  });

  it('TIM3 16 位递减计数在 0 处回绕到 0xFFFF，且高位被屏蔽', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM3, ARR, 0xffff);
      timerWrite(body, TIM3, CNT, 1);
      timerWrite(body, TIM3, DIER, DIER_UIE);
      timerWrite(body, TIM3, CR1, CR1_CEN | (1 << 4));
      body.redirect(2, 2_000_000);
    };
    const inspect: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM3, CNT));
      write(body, 'result1', timerRead(body, TIM3, SR));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, inspect] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_100_000);

      expect(rig.state('result0')).toBe(0xffff);
      expect(Number(rig.state('result1')) & SR_UIF).toBe(SR_UIF);
    } finally {
      rig.dispose();
    }
  });

  it('ARR/CCR 预装载在 UG 前保持旧比较值，UG 后切换', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 999);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x68); // OC1PE | PWM mode 1
      timerWrite(body, TIM2, CCR1, 100);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN | CR1_ARPE);
      timerWrite(body, TIM2, EGR, EGR_UG);
      body.redirect(2, 50_000_000);
    };
    const beforeUpdate: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(
        body,
        'result0',
        body.select(
          types.number,
          timerChannelLevel(body, timerConfig('TIM2'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      timerWrite(body, TIM2, CCR1, 900);
      body.redirect(4, 100_000_000);
    };
    const afterCounter: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(
        body,
        'result1',
        body.select(
          types.number,
          timerChannelLevel(body, timerConfig('TIM2'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );

      timerWrite(body, TIM2, EGR, EGR_UG);
      body.redirect(6, 1_000_000);
    };
    const afterUpdate: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(
        body,
        'result2',
        body.select(
          types.number,
          timerChannelLevel(body, timerConfig('TIM2'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      body.stop();
    };
    const rig = await createTimRig({
      steps: [init, beforeUpdate, afterCounter, afterUpdate],
    });

    try {
      rig.runUntil(0);
      rig.runUntil(160_000_000);

      expect(rig.state('result0')).toBe(1); // t=50 us, old CCR=100 → still high
      expect(rig.state('result1')).toBe(0); // t=150 us, old CCR=100 → low
      expect(rig.state('result2')).toBe(1); // UG 后 CCR=900，CNT=1 → high
    } finally {
      rig.dispose();
    }
  });

  it('PA15/TIM2_CH1 AF1 捕获两个真实上升沿，CCR 读取清 CC1IF', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioA');
      enableClock(body, 'tim2');
      body.writeState('gpioModer0', num(body, 2 << 30));
      body.writeState('gpioAfr10', num(body, 1 << 28));
      timerWrite(body, TIM2, ARR, 0xffffffff);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x1); // CC1S = TI1
      timerWrite(body, TIM2, CCER, 0x1); // CC1E, rising
      timerWrite(body, TIM2, DIER, DIER_CC1IE);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 1_000_000);
    };
    const first: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, 1_000_000), bool(body, true));
      const captured = timerRead(body, TIM2, CCR1);
      const afterRead = timerRead(body, TIM2, SR);

      write(body, 'result0', captured);
      write(
        body,
        'result3',
        body.select(
          types.number,
          body.equal(types.number, body.bitAnd(afterRead, num(body, SR_CC1IF)), num(body, 0)),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      body.redirect(4, 2_000_000);
    };
    const falling: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, 3_000_000), bool(body, false));
      body.redirect(6, 2_000_000);
    };
    const second: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, 5_000_000), bool(body, true));
      write(body, 'result1', timerRead(body, TIM2, CCR1));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, first, falling, second] });

    try {
      rig.runUntil(0);
      rig.runUntil(900_000);
      rig.send('PA15', 1);
      rig.runUntil(1_000_000);
      rig.runUntil(2_900_000);
      rig.send('PA15', 0);
      rig.runUntil(3_000_000);
      rig.runUntil(4_900_000);
      rig.send('PA15', 1);
      rig.runUntil(5_100_000);

      expect(rig.state('result0')).toBe(1);
      expect(rig.state('result1')).toBe(5);
      expect(rig.state('result3')).toBe(1);
      expect(Number(rig.state('result1')) - Number(rig.state('result0'))).toBe(4);
    } finally {
      rig.dispose();
    }
  });

  it('捕获 observer 的绝对 timePs 超过 2^32 ps 后仍是安全整数', async () => {
    const edgePs = 5_000_000_000;
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioA');
      enableClock(body, 'tim2');
      body.writeState('gpioModer0', num(body, 2 << 30));
      body.writeState('gpioAfr10', num(body, 1 << 28));
      timerWrite(body, TIM2, ARR, 0xffffffff);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x1);
      timerWrite(body, TIM2, CCER, 0x1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 1_000);
    };
    const edge: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, edgePs), bool(body, true));
      write(
        body,
        'result3',
        body.select(
          types.number,
          body.equal(types.number, state(body, 'tim2LastPs'), num(body, edgePs)),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      write(body, 'result0', timerRead(body, TIM2, CCR1));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, edge] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      // 1 MHz rig clock：5e9 ps = 5000 counts；LastPs 若被 u32 截断则不会等于 5e9。
      expect(rig.state('result3')).toBe(1);
      expect(rig.state('result0')).toBe(5000);
    } finally {
      rig.dispose();
    }
  });

  it('PA15 上 0.2 µs 短脉冲不会因 1 µs 轮询被吞掉', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioA');
      enableClock(body, 'tim2');
      body.writeState('gpioModer0', num(body, 2 << 30));
      body.writeState('gpioAfr10', num(body, 1 << 28));
      timerWrite(body, TIM2, ARR, 0xffffffff);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x1);
      timerWrite(body, TIM2, CCER, 0x1);
      timerWrite(body, TIM2, DIER, DIER_CC1IE);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 1_000_000);
    };
    const high: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, 1_000_000), bool(body, true));
      write(body, 'result0', timerRead(body, TIM2, CCR1));
      body.redirect(4, 200_000);
    };
    const low: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, 1_200_000), bool(body, false));
      body.redirect(6, 800_000);
    };
    const highAgain: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, 2_000_000), bool(body, true));
      write(body, 'result1', timerRead(body, TIM2, CCR1));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, high, low, highAgain] });

    try {
      rig.runUntil(0);
      rig.runUntil(900_000);
      rig.send('PA15', 1);
      rig.runUntil(1_000_000);
      rig.runUntil(1_100_000);
      rig.send('PA15', 0);
      rig.runUntil(1_200_000);
      rig.runUntil(1_900_000);
      rig.send('PA15', 1);
      rig.runUntil(2_100_000);

      expect(rig.state('result0')).toBe(1);
      expect(rig.state('result1')).toBe(2);
      expect(Number(rig.state('result1')) - Number(rig.state('result0'))).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('PB4/TIM3_CH1 AF2 下降沿极性与 CCER 极性位', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioB');
      enableClock(body, 'tim3');
      body.writeState('gpioModer1', num(body, 2 << 8));
      body.writeState('gpioAfr01', num(body, 2 << 16));
      timerWrite(body, TIM3, ARR, 0xffff);
      timerWrite(body, TIM3, PSC, 0);
      timerWrite(body, TIM3, CCMR1, 0x1);
      timerWrite(body, TIM3, CCER, 0x3); // CC1E | CC1P falling
      timerWrite(body, TIM3, DIER, DIER_CC1IE);
      timerWrite(body, TIM3, CR1, CR1_CEN);
      body.redirect(2, 1_000_000);
    };
    const high: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PB4', num(body, 1_000_000), bool(body, true));
      body.redirect(4, 2_000_000);
    };
    const low: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PB4', num(body, 3_000_000), bool(body, false));
      write(body, 'result0', timerRead(body, TIM3, CCR1));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, high, low] });

    try {
      rig.runUntil(0);
      rig.runUntil(900_000);
      rig.send('PB4', 1);
      rig.runUntil(1_000_000);
      rig.runUntil(2_900_000);
      rig.send('PB4', 0);
      rig.runUntil(3_100_000);

      expect(rig.state('result0')).toBe(3);
    } finally {
      rig.dispose();
    }
  });

  it('capture gate descriptor 给 PA15/PB4 正确的寄存器槽位与 AF nibble', () => {
    const descriptors = timerCaptureGateDescriptors();
    const pa15 = descriptors.find(
      (descriptor) => descriptor.pinName === 'PA15' && descriptor.timerName === 'TIM2',
    );
    const pb4 = descriptors.find(
      (descriptor) => descriptor.pinName === 'PB4' && descriptor.timerName === 'TIM3',
    );

    if (pa15 === undefined || pb4 === undefined) throw new Error('capture descriptor missing');

    expect(pa15).toMatchObject({
      channel: 1,
      af: 1,
      timerMemoryOffset: 0x48,
      cr1Offset: 0x00,
      ccmrOffset: 0x18,
      ccxsShift: 0,
      ccerOffset: 0x20,
      ccerShift: 0,
      moderState: 'gpioModer0',
      moderShift: 30,
      afrState: 'gpioAfr10',
      afrShift: 28,
    });
    expect(pa15.timerClockGate).toMatchObject({ enable: 0x58, bit: 0 });
    expect(pa15.gpioClockGate).toMatchObject({ enable: 0x4c, bit: 0 });

    // PB4 的关键：AFR[0] 的 nibble 4（shift 16），不是 PB0 的低 nibble。
    expect(pb4).toMatchObject({
      channel: 1,
      af: 2,
      timerMemoryOffset: 0x90,
      cr1Offset: 0x00,
      ccmrOffset: 0x18,
      ccxsShift: 0,
      ccerOffset: 0x20,
      ccerShift: 0,
      moderState: 'gpioModer1',
      moderShift: 8,
      afrState: 'gpioAfr01',
      afrShift: 16,
    });
    expect(pb4.timerClockGate).toMatchObject({ enable: 0x58, bit: 1 });
    expect(pb4.gpioClockGate).toMatchObject({ enable: 0x4c, bit: 1 });
  });

  it('PB4 armed 读 AFR[0] 的 PB4 nibble，并要求 CC1S==1 与 GPIO/TIM clockgate', async () => {
    const init: (body: Body) => void = (body) => {
      body.writeState('gpioModer1', num(body, 2 << 8)); // PB4 AF
      body.writeState('gpioAfr01', num(body, 2)); // PB0=AF2，PB4 nibble 仍为 0
      timerWrite(body, TIM3, ARR, 0xffff);
      timerWrite(body, TIM3, PSC, 0);
      timerWrite(body, TIM3, CCMR1, 0x1);
      timerWrite(body, TIM3, CCER, 0x1);
      timerWrite(body, TIM3, CR1, CR1_CEN);
      body.redirect(2, 1_000);
    };
    const inspect: (body: Body) => void = (body) => {
      boolNumberAt(body, 'result0', isTimerCaptureArmedOnPin(body, 'PB4'));
      enableClock(body, 'gpioB');
      boolNumberAt(body, 'result1', isTimerCaptureArmedOnPin(body, 'PB4'));
      enableClock(body, 'tim3');
      boolNumberAt(body, 'result2', isTimerCaptureArmedOnPin(body, 'PB4'));
      // 低 nibble (PB0)=2，高 nibble (PB4)=2；只看 PB4 应 armed。
      body.writeState('gpioAfr01', num(body, 2 | (2 << 16)));
      boolNumberAt(body, 'result3', isTimerCaptureArmedOnPin(body, 'PB4'));
      timerWrite(body, TIM3, CCMR1, 0x2); // indirect
      boolNumberAt(body, 'result4', isTimerCaptureArmedOnPin(body, 'PB4'));
      timerWrite(body, TIM3, CCMR1, 0x3); // TRC
      boolNumberAt(body, 'result5', isTimerCaptureArmedOnPin(body, 'PB4'));
      timerWrite(body, TIM3, CCMR1, 0x1); // direct TI1
      boolNumberAt(body, 'result6', isTimerCaptureArmedOnPin(body, 'PB4'));
      body.redirect(4, 1_000);
    };
    const rig = await createTimRig({ steps: [init, inspect, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_100);

      expect(rig.state('result0')).toBe(0); // GPIO clock off
      expect(rig.state('result1')).toBe(0); // TIM clock off
      expect(rig.state('result2')).toBe(0); // PB4 nibble 仍错
      expect(rig.state('result3')).toBe(1); // 正确 PB4 AF2
      expect(rig.state('result4')).toBe(0); // CC1S=2 不支持
      expect(rig.state('result5')).toBe(0); // CC1S=3 不支持
      expect(rig.state('result6')).toBe(1); // direct TI1
    } finally {
      rig.dispose();
    }
  });

  it('ByPin armed 只看本脚：同 channel 的 PC6 AF 正确不能放行 PB4', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioB');
      enableClock(body, 'gpioC');
      enableClock(body, 'tim3');
      body.writeState('gpioModer1', num(body, 2 << 8)); // PB4 AF
      body.writeState('gpioAfr01', num(body, 0)); // PB4 AF 错
      body.writeState('gpioModer2', num(body, 2 << 12)); // PC6 AF
      body.writeState('gpioAfr02', num(body, 2 << 24)); // PC6 AF2，正确
      timerWrite(body, TIM3, ARR, 0xffff);
      timerWrite(body, TIM3, PSC, 0);
      timerWrite(body, TIM3, CCMR1, 0x1);
      timerWrite(body, TIM3, CCER, 0x1);
      timerWrite(body, TIM3, CR1, CR1_CEN);
      body.redirect(2, 1_000);
    };
    const inspect: (body: Body) => void = (body) => {
      boolNumberAt(body, 'result0', isTimerCaptureArmedOnPin(body, 'PB4'));
      boolNumberAt(body, 'result4', isTimerCaptureArmedOnPin(body, 'PC6'));
      observeTimerInputByPin(body, 'PB4', num(body, 1_000_000), bool(body, true));
      write(body, 'result1', timerRead(body, TIM3, CCR1));
      body.writeState('gpioAfr01', num(body, 2 << 16)); // 修正 PB4 nibble
      boolNumberAt(body, 'result2', isTimerCaptureArmedOnPin(body, 'PB4'));
      observeTimerInputByPin(body, 'PB4', num(body, 2_000_000), bool(body, true));
      write(body, 'result3', timerRead(body, TIM3, CCR1));
      body.redirect(4, 1_000);
    };
    const rig = await createTimRig({ steps: [init, inspect, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_100);

      expect(rig.state('result0')).toBe(0);
      expect(rig.state('result1')).toBe(0);
      expect(rig.state('result4')).toBe(1);
      expect(rig.state('result2')).toBe(1);
      expect(Number(rig.state('result3'))).toBeGreaterThan(0);
    } finally {
      rig.dispose();
    }
  });

  it('capture armed 在 GPIO/TIM reset held 时为 false', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioB');
      enableClock(body, 'tim3');
      body.writeState('gpioModer1', num(body, 2 << 8));
      body.writeState('gpioAfr01', num(body, 2 << 16));
      timerWrite(body, TIM3, ARR, 0xffff);
      timerWrite(body, TIM3, PSC, 0);
      timerWrite(body, TIM3, CCMR1, 0x1);
      timerWrite(body, TIM3, CCER, 0x1);
      timerWrite(body, TIM3, CR1, CR1_CEN);
      body.redirect(2, 1_000);
    };
    const inspect: (body: Body) => void = (body) => {
      boolNumberAt(body, 'result0', isTimerCaptureArmedOnPin(body, 'PB4'));
      setClockReset(body, 'tim3', true);
      boolNumberAt(body, 'result1', isTimerCaptureArmedOnPin(body, 'PB4'));
      setClockReset(body, 'tim3', false);
      setClockReset(body, 'gpioB', true);
      boolNumberAt(body, 'result2', isTimerCaptureArmedOnPin(body, 'PB4'));
      setClockReset(body, 'gpioB', false);
      boolNumberAt(body, 'result3', isTimerCaptureArmedOnPin(body, 'PB4'));
      body.redirect(4, 1_000);
    };
    const rig = await createTimRig({ steps: [init, inspect, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_100);

      expect(rig.state('result0')).toBe(1);
      expect(rig.state('result1')).toBe(0); // TIM3 reset held
      expect(rig.state('result2')).toBe(0); // GPIOB reset held
      expect(rig.state('result3')).toBe(1); // reset released
    } finally {
      rig.dispose();
    }
  });

  it('armed baseline 后仅关/开 GPIOB 或 TIM3 clockgate 会单独翻转', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioB');
      enableClock(body, 'tim3');
      body.writeState('gpioModer1', num(body, 2 << 8));
      body.writeState('gpioAfr01', num(body, 2 << 16));
      timerWrite(body, TIM3, ARR, 0xffff);
      timerWrite(body, TIM3, PSC, 0);
      timerWrite(body, TIM3, CCMR1, 0x1);
      timerWrite(body, TIM3, CCER, 0x1);
      timerWrite(body, TIM3, CR1, CR1_CEN);
      body.redirect(2, 1_000);
    };
    const inspect: (body: Body) => void = (body) => {
      // AF/CC1S/CC1E/CEN 全部正确，baseline 必须 armed。
      boolNumberAt(body, 'result0', isTimerCaptureArmedOnPin(body, 'PB4'));
      disableClock(body, 'gpioB');
      boolNumberAt(body, 'result1', isTimerCaptureArmedOnPin(body, 'PB4'));
      enableClock(body, 'gpioB');
      boolNumberAt(body, 'result2', isTimerCaptureArmedOnPin(body, 'PB4'));
      disableClock(body, 'tim3');
      boolNumberAt(body, 'result3', isTimerCaptureArmedOnPin(body, 'PB4'));
      enableClock(body, 'tim3');
      boolNumberAt(body, 'result4', isTimerCaptureArmedOnPin(body, 'PB4'));
      body.redirect(4, 1_000);
    };
    const rig = await createTimRig({ steps: [init, inspect, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_100);

      expect(rig.state('result0')).toBe(1); // baseline
      expect(rig.state('result1')).toBe(0); // 仅 GPIOB gate off
      expect(rig.state('result2')).toBe(1); // 仅 GPIOB gate on
      expect(rig.state('result3')).toBe(0); // 仅 TIM3 gate off
      expect(rig.state('result4')).toBe(1); // 仅 TIM3 gate on
    } finally {
      rig.dispose();
    }
  });

  it('armed baseline 后仅关/开 CEN 或 CC1E 会单独翻转', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioB');
      enableClock(body, 'tim3');
      body.writeState('gpioModer1', num(body, 2 << 8));
      body.writeState('gpioAfr01', num(body, 2 << 16));
      timerWrite(body, TIM3, ARR, 0xffff);
      timerWrite(body, TIM3, PSC, 0);
      timerWrite(body, TIM3, CCMR1, 0x1);
      timerWrite(body, TIM3, CCER, 0x1);
      timerWrite(body, TIM3, CR1, CR1_CEN);
      body.redirect(2, 1_000);
    };
    const inspect: (body: Body) => void = (body) => {
      boolNumberAt(body, 'result0', isTimerCaptureArmedOnPin(body, 'PB4'));
      timerWrite(body, TIM3, CR1, 0);
      boolNumberAt(body, 'result1', isTimerCaptureArmedOnPin(body, 'PB4'));
      timerWrite(body, TIM3, CR1, CR1_CEN);
      boolNumberAt(body, 'result2', isTimerCaptureArmedOnPin(body, 'PB4'));
      timerWrite(body, TIM3, CCER, 0);
      boolNumberAt(body, 'result3', isTimerCaptureArmedOnPin(body, 'PB4'));
      timerWrite(body, TIM3, CCER, 0x1);
      boolNumberAt(body, 'result4', isTimerCaptureArmedOnPin(body, 'PB4'));
      body.redirect(4, 1_000);
    };
    const rig = await createTimRig({ steps: [init, inspect, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_100);

      expect(rig.state('result0')).toBe(1); // baseline
      expect(rig.state('result1')).toBe(0); // 仅 CEN=0
      expect(rig.state('result2')).toBe(1); // CEN=1
      expect(rig.state('result3')).toBe(0); // 仅 CC1E=0
      expect(rig.state('result4')).toBe(1); // CC1E=1
    } finally {
      rig.dispose();
    }
  });

  it('TIM2_CH1 PWM 以有限电阻输出，10 µs 采样得到 25% 占空比与 1 kHz 周期', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 999);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x60); // PWM mode 1
      timerWrite(body, TIM2, CCR1, 250);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 10_000_000);
    };
    const sample: (body: Body) => void = (body) => {
      advanceTimers(body);
      const driver = timerDrivers().find(
        (candidate) => candidate.port === 0 && candidate.pin === 0 && candidate.af === 1,
      );

      if (driver === undefined) throw new Error('PA0 TIM2_CH1 driver is missing');

      const active = driver.active(body);
      const level = driver.level(body);
      const high = body.resistor('VDD', num(body, 25));
      const low = body.resistor('VSS', num(body, 25));
      const intent = body.select(
        types.intent,
        active,
        (on) =>
          on.select(
            types.intent,
            level,
            () => high,
            () => low,
          ),
        (off) => off.combineIntents(),
      );

      body.writeIntent('PA0', intent);
      const runs = state(body, 'runs');

      write(body, 'runs', body.add(runs, num(body, 1)));
      body.if(
        body.greaterThanOrEqual(body.add(runs, num(body, 1)), num(body, 250)),
        (done) => done.stop(),
        (next) => next.redirect(2, 10_000_000),
      );
    };
    const rig = await createTimRig({ steps: [init, sample] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_500_100_000);

      const history = rig.probeHistory.filter((value) => value === 0 || value === 1);
      let rises = 0;

      for (let index = 1; index < history.length; index += 1)
        if (history[index - 1] === 0 && history[index] === 1) rises += 1;
      const high = history.filter((value) => value === 1).length;
      const duty = high / history.length;
      const risingIndices: number[] = [];

      for (let index = 1; index < history.length; index += 1)
        if (history[index - 1] === 0 && history[index] === 1) risingIndices.push(index);

      expect(rises).toBeGreaterThanOrEqual(2);
      expect(duty).toBeGreaterThan(0.22);
      expect(duty).toBeLessThan(0.31);
      if (risingIndices.length >= 2)
        expect(risingIndices[1]! - risingIndices[0]!).toBeGreaterThanOrEqual(98);
      if (risingIndices.length >= 2)
        expect(risingIndices[1]! - risingIndices[0]!).toBeLessThanOrEqual(102);
    } finally {
      rig.dispose();
    }
  });

  it('停止 10 µs 后重新使能，不把停止期间的时间算进 CNT', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 0xffffffff);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 5_000_000);
    };
    const stop: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM2, CNT));
      timerWrite(body, TIM2, CR1, 0);
      body.redirect(4, 10_000_000);
    };
    const restart: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(6, 2_000_000);
    };
    const inspect: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result1', timerRead(body, TIM2, CNT));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, stop, restart, inspect] });

    try {
      rig.runUntil(0);
      rig.runUntil(17_100_000);

      expect(rig.state('result0')).toBe(5);
      expect(rig.state('result1')).toBe(7);
    } finally {
      rig.dispose();
    }
  });

  it('高级定时器输出额外受 BDTR.MOE 门控，通用定时器没有这个差异', async () => {
    const inspect: (body: Body) => void = (body) => {
      timerWrite(body, TIM1, ARR, 999);
      timerWrite(body, TIM1, CCMR1, 0x60);
      timerWrite(body, TIM1, CCR1, 100);
      timerWrite(body, TIM1, CCER, 1);
      timerWrite(body, TIM1, CR1, CR1_CEN);
      advanceTimers(body);
      write(
        body,
        'result0',
        body.select(
          types.number,
          timerChannelActive(body, timerConfig('TIM1'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      timerWrite(body, TIM1, BDTR, 0x8000);
      body.redirect(2, 1_000);
    };
    const moeOn: (body: Body) => void = (body) => {
      // 不调用 advanceTimers：验证寄存器写路径已经刷新 Out 缓存。
      write(
        body,
        'result1',
        body.select(
          types.number,
          timerChannelActive(body, timerConfig('TIM1'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      body.stop();
    };
    const rig = await createTimRig({ steps: [inspect, moeOn] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(rig.state('result0')).toBe(0);
      expect(rig.state('result1')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('TIM6 基本定时器只有更新 IRQ 54，不冒充 CC 通道', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM6, ARR, 9);
      timerWrite(body, TIM6, DIER, DIER_UIE);
      timerWrite(body, TIM6, CR1, CR1_CEN);
      body.redirect(2, 10_000_000);
    };
    const inspect: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM6, SR));
      boolNumber(body, timerIrqPending(body, 54));
      timerWrite(body, TIM6, SR, 0);
      write(
        body,
        'result4',
        body.select(
          types.number,
          timerIrqPending(body, 54),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, inspect] });

    try {
      rig.runUntil(0);
      rig.runUntil(10_100_000);

      expect(rig.state('result0')).toBe(SR_UIF);
      expect(rig.state('result3')).toBe(1);
      expect(rig.state('result4')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('16 MHz / ARR=15 / CCR=7 的 deadline 是下一个比较 437.5 ns，而不是固定 1 µs', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 15);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x60);
      timerWrite(body, TIM2, CCR1, 7);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      advanceTimers(body);
      write(body, 'result0', state(body, 'periphDeadline0'));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init], clockFrequency: 16_000_000 });

    try {
      rig.runUntil(1);

      expect(rig.state('result0')).toBe(437_500);
    } finally {
      rig.dispose();
    }
  });

  it('CNT 越过 CCR 后 deadline 指向下一周期的比较点，而不是错误缩短', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 9);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x60);
      timerWrite(body, TIM2, CCR1, 3);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CNT, 5);
      timerWrite(body, TIM2, CR1, CR1_CEN | 0x2); // UDIS，隔离更新事件
      advanceTimers(body);
      write(body, 'result0', state(body, 'periphDeadline0'));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init] });

    try {
      rig.runUntil(1);

      // 从 CNT=5 到下一周期 CCR=3 共 8 个计数；1 MHz 下为 8 µs。
      expect(rig.state('result0')).toBe(8_000_000);
    } finally {
      rig.dispose();
    }
  });

  it('1 MHz PWM 经有限电阻真实引脚输出，probe 以 62.5 ns 采样看到周期和占空比', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 15);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x60);
      timerWrite(body, TIM2, CCR1, 7);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 62_500);
    };
    const sample: (body: Body) => void = (body) => {
      advanceTimers(body);
      const driver = timerDrivers().find(
        (candidate) => candidate.port === 0 && candidate.pin === 0 && candidate.af === 1,
      );

      if (driver === undefined) throw new Error('PA0 TIM2_CH1 driver is missing');
      const active = driver.active(body);
      const level = driver.level(body);
      const high = body.resistor('VDD', num(body, 25));
      const low = body.resistor('VSS', num(body, 25));
      const intent = body.select(
        types.intent,
        active,
        (on) =>
          on.select(
            types.intent,
            level,
            () => high,
            () => low,
          ),
        (off) => off.combineIntents(),
      );

      body.writeIntent('PA0', intent);
      const runs = state(body, 'runs');

      write(body, 'runs', body.add(runs, num(body, 1)));
      body.if(
        body.greaterThanOrEqual(body.add(runs, num(body, 1)), num(body, 40)),
        (done) => done.stop(),
        (next) => next.redirect(2, 62_500),
      );
    };
    const rig = await createTimRig({
      steps: [init, sample],
      clockFrequency: 16_000_000,
      probePeriodPs: 62_500,
    });

    try {
      rig.runUntil(0);
      rig.runUntil(2_600_000);

      const history = rig.probeHistory.filter((value) => value === 0 || value === 1);
      const rising: number[] = [];

      for (let index = 1; index < history.length; index += 1)
        if (history[index - 1] === 0 && history[index] === 1) rising.push(index);
      const duty = history.filter((value) => value === 1).length / history.length;

      expect(rising.length).toBeGreaterThanOrEqual(2);
      if (rising.length >= 2) expect(rising[1]! - rising[0]!).toBeGreaterThanOrEqual(14);
      if (rising.length >= 2) expect(rising[1]! - rising[0]!).toBeLessThanOrEqual(18);
      expect(duty).toBeGreaterThan(0.35);
      expect(duty).toBeLessThan(0.55);
    } finally {
      rig.dispose();
    }
  });

  it('一次长推进跨更新时，新 ARR/PSC 立即影响余下时间', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 9);
      timerWrite(body, TIM2, PSC, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      timerWrite(body, TIM2, EGR, EGR_UG);
      body.redirect(2, 10_000_000);
    };
    const reconfigure: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 3);
      timerWrite(body, TIM2, PSC, 0);
      body.redirect(4, 110_000_000);
    };
    const inspect: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM2, CNT));
      write(body, 'result1', timerRead(body, TIM2, SR));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, reconfigure, inspect] });

    try {
      rig.runUntil(0);
      rig.runUntil(120_100_000);

      expect(rig.state('result0')).toBe(0);
      expect(Number(rig.state('result1')) & SR_UIF).toBe(SR_UIF);
    } finally {
      rig.dispose();
    }
  });

  it('OPM + RCR=1 停在第一次有效更新（第二次溢出），不是第一次溢出', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM16, ARR, 9);
      timerWrite(body, TIM16, PSC, 0);
      timerWrite(body, TIM16, RCR, 1);
      timerWrite(body, TIM16, CR1, CR1_CEN | CR1_OPM);
      body.redirect(2, 100_000_000);
    };
    const inspect: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM16, CNT));
      write(body, 'result1', body.bitAnd(timerRead(body, TIM16, CR1), num(body, CR1_CEN)));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, inspect] });

    try {
      rig.runUntil(0);
      rig.runUntil(100_100_000);

      expect(rig.state('result0')).toBe(0);
      expect(rig.state('result1')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('OPM 停止后重算仍在运行的定时器节拍，最后一个停止后清除活动槽', async () => {
    const init = (body: Body): void => {
      timerWrite(body, TIM2, ARR, 124);
      timerWrite(body, TIM3, ARR, 99);
      timerWrite(body, TIM2, CR1, CR1_CEN | CR1_OPM);
      timerWrite(body, TIM3, CR1, CR1_CEN | CR1_OPM);
      body.redirect(2, 100_000_000);
    };
    const firstStop = (body: Body): void => {
      advanceTimers(body);
      body.redirect(4, 25_000_000);
    };
    const lastStop = (body: Body): void => {
      advanceTimers(body);
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, firstStop, lastStop] });

    try {
      rig.runUntil(100_000_001);
      expect(rig.state('timCenMask')).toBe(1 << 1); // TIM2 only
      expect(rig.state('periphActive')).toBe(1);
      expect(rig.state('periphDeadline0')).toBe(25_000_000);
      expect(rig.state('tickPs')).toBe(25_000_000);
      expect(rig.state('tickActive')).toBe(true);

      rig.runUntil(125_000_001);
      expect(rig.state('timCenMask')).toBe(0);
      expect(rig.state('periphActive')).toBe(0);
      expect(rig.state('tickActive')).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('CMS=1 基本中心对齐：0→ARR 后翻转 DIR，再回到 0 翻转', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 3);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CR1, CR1_CEN | 0x20);
      body.redirect(2, 3_000_000);
    };
    const atArr: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM2, CNT));
      write(body, 'result1', body.bitAnd(timerRead(body, TIM2, CR1), num(body, 0x10)));
      body.redirect(4, 3_000_000);
    };
    const atZero: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result2', timerRead(body, TIM2, CNT));
      write(body, 'result4', body.bitAnd(timerRead(body, TIM2, CR1), num(body, 0x10)));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, atArr, atZero] });

    try {
      rig.runUntil(0);
      rig.runUntil(6_100_000);

      expect(rig.state('result0')).toBe(3);
      expect(rig.state('result1')).toBe(0x10);
      expect(rig.state('result2')).toBe(0);
      expect(rig.state('result4')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('CMS=1 中心对齐 PWM 在上升/下降两段按 CNT 与 CCR 比较输出', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 4);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x60); // PWM1
      timerWrite(body, TIM2, CCR1, 2);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN | 0x20); // CMS=1
      body.redirect(2, 1_100_000);
    };
    const sample = (name: string, next: number, delay: number): ((body: Body) => void) => {
      return (body) => {
        advanceTimers(body);
        write(
          body,
          name,
          body.select(
            types.number,
            timerChannelLevel(body, timerConfig('TIM2'), 1),
            (yes) => yes.constant(types.number, 1),
            (no) => no.constant(types.number, 0),
          ),
        );
        body.redirect(next, delay);
      };
    };
    const rig = await createTimRig({
      steps: [
        init,
        sample('result0', 4, 1_000_000), // 1.1 µs，上升段 CNT=1
        sample('result1', 6, 3_000_000), // 2.1 µs，上升段 CNT=2
        sample('result2', 8, 1_000_000), // 5.1 µs，下降段 CNT=3
        sample('result3', 10, 1_000_000), // 6.1 µs，下降段 CNT=2
        (body) => body.stop(),
      ],
    });

    try {
      rig.runUntil(0);
      for (const time of [1_100_000, 2_100_000, 5_100_000, 6_100_000]) rig.runUntil(time);

      expect(rig.state('result0')).toBe(1);
      expect(rig.state('result1')).toBe(0);
      expect(rig.state('result2')).toBe(1);
      expect(rig.state('result3')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('比较匹配只在计数器真正到达 CCR 时置 CC1IF', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 9);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x60); // PWM1，确保比较通道处于输出模式
      timerWrite(body, TIM2, CCR1, 7);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, DIER, DIER_CC1IE);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 3_000_000);
    };
    const beforeMatch: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', body.bitAnd(timerRead(body, TIM2, SR), num(body, SR_CC1IF)));
      body.redirect(4, 4_000_000);
    };
    const atMatch: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result1', body.bitAnd(timerRead(body, TIM2, SR), num(body, SR_CC1IF)));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, beforeMatch, atMatch] });

    try {
      rig.runUntil(0);
      rig.runUntil(3_100_000);
      rig.runUntil(7_100_000);

      expect(rig.state('result0')).toBe(0);
      expect(rig.state('result1')).toBe(SR_CC1IF);
    } finally {
      rig.dispose();
    }
  });

  it('递减计数只在真正到达 CCR 时置 CC1IF', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 9);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x60);
      timerWrite(body, TIM2, CCR1, 2);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, DIER, DIER_CC1IE);
      timerWrite(body, TIM2, CNT, 9);
      timerWrite(body, TIM2, CR1, CR1_CEN | 0x10); // DIR=down
      body.redirect(2, 3_000_000);
    };
    const beforeMatch: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result0', body.bitAnd(timerRead(body, TIM2, SR), num(body, SR_CC1IF)));
      body.redirect(4, 4_000_000);
    };
    const atMatch: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(body, 'result1', body.bitAnd(timerRead(body, TIM2, SR), num(body, SR_CC1IF)));
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, beforeMatch, atMatch] });

    try {
      rig.runUntil(0);
      rig.runUntil(3_100_000);
      rig.runUntil(7_100_000);

      expect(rig.state('result0')).toBe(0);
      expect(rig.state('result1')).toBe(SR_CC1IF);
    } finally {
      rig.dispose();
    }
  });

  it('OC 模式 1/2/3 的 set/clear/toggle 电平生效', async () => {
    const init: (body: Body) => void = (body) => {
      timerWrite(body, TIM2, ARR, 9);
      timerWrite(body, TIM2, PSC, 0);
      timerWrite(body, TIM2, CCMR1, 0x10); // OC1M=001 set on match
      timerWrite(body, TIM2, CCR1, 2);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      body.redirect(2, 3_000_000);
    };
    const set: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(
        body,
        'result0',
        body.select(
          types.number,
          timerChannelLevel(body, timerConfig('TIM2'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      timerWrite(body, TIM2, CCMR1, 0x20); // clear on match
      body.redirect(4, 10_000_000);
    };
    const clear: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(
        body,
        'result1',
        body.select(
          types.number,
          timerChannelLevel(body, timerConfig('TIM2'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      timerWrite(body, TIM2, CCMR1, 0x30); // toggle on match
      body.redirect(6, 10_000_000);
    };
    const toggle: (body: Body) => void = (body) => {
      advanceTimers(body);
      write(
        body,
        'result2',
        body.select(
          types.number,
          timerChannelLevel(body, timerConfig('TIM2'), 1),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, set, clear, toggle] });

    try {
      rig.runUntil(0);
      rig.runUntil(23_100_000);

      expect(rig.state('result0')).toBe(1);
      expect(rig.state('result1')).toBe(0);
      expect(rig.state('result2')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('一次长 advance 与每 10 µs 分批 advance 的计数结果等价（PSC/ARR）', async () => {
    const configure = (body: Body, next: number, delay: number): void => {
      timerWrite(body, TIM2, ARR, 9);
      timerWrite(body, TIM2, PSC, 1);
      timerWrite(body, TIM2, CCMR1, 0x60);
      timerWrite(body, TIM2, CCR1, 4);
      timerWrite(body, TIM2, CCER, 1);
      timerWrite(body, TIM2, CR1, CR1_CEN);
      timerWrite(body, TIM2, EGR, EGR_UG);
      body.redirect(next, delay);
    };
    const inspect = (body: Body): void => {
      advanceTimers(body);
      write(body, 'result0', timerRead(body, TIM2, CNT));
      write(body, 'result1', state(body, 'tim2Out1'));
      body.stop();
    };
    const long = await createTimRig({
      steps: [(body) => configure(body, 2, 101_000_000), inspect],
    });
    const splitInit = await createTimRig({
      steps: [
        (body) => configure(body, 2, 10_000_000),
        (body) => {
          advanceTimers(body);
          const runs = state(body, 'runs');
          const next = body.add(runs, num(body, 1));

          write(body, 'runs', next);
          body.if(
            body.greaterThanOrEqual(next, num(body, 10)),
            (done) => done.redirect(6, 1_000_000),
            (again) => again.redirect(2, 10_000_000),
          );
        },
        (body) => {
          advanceTimers(body);
          write(body, 'result0', timerRead(body, TIM2, CNT));
          write(body, 'result1', state(body, 'tim2Out1'));
          body.stop();
        },
      ],
    });

    try {
      long.runUntil(0);
      long.runUntil(101_100_000);
      splitInit.runUntil(0);
      splitInit.runUntil(101_100_000);

      expect(long.state('result0')).toBeDefined();
      expect(splitInit.state('result0')).toBeDefined();
      expect(splitInit.state('result0')).toBe(long.state('result0'));
    } finally {
      long.dispose();
      splitInit.dispose();
    }
  });
});

function timerConfig(name: 'TIM1' | 'TIM2' | 'TIM3'): (typeof TIMERS)[number] {
  const found = TIMERS.find((candidate) => candidate.name === name);

  if (found === undefined) throw new Error(`missing ${name}`);

  return found;
}
