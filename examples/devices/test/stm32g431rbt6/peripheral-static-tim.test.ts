import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import { readPeripheral, writePeripheral } from '@mica-js/stm32g431rbt6-core/bus';
import { SERVICE_DEFER_WRITE } from '@mica-js/stm32g431rbt6-core/layout';
import {
  TIMER_REGISTER_STRIDE,
  observeTimerInputByPin,
  timerConfigAt,
  timerModule,
} from '@mica-js/stm32g431rbt6-core/tim';
import {
  ARR,
  CCR1,
  CCMR1,
  CCER,
  CNT,
  CR1,
  CR1_CEN,
  DIER,
  DIER_CC1IE,
  EGR,
  EGR_UG,
  PSC,
  SR,
  TIM2,
  TIM3,
  TIM6,
  createTimRig,
  enableClock,
} from './tim-rig';

const num = (b: Body, value: number) => b.constant(types.number, value);
const write = (b: Body, name: string, value: number | Value<number>) =>
  b.writeState(name, typeof value === 'number' ? num(b, value) : value);

const staticWrite = (
  b: Body,
  address: number,
  size: 1 | 2 | 4,
  value: number,
  defer = false,
): void => writePeripheral(b, num(b, address), size, num(b, value), defer, address, value);

const staticRead = (b: Body, address: number, size: 1 | 2 | 4) =>
  readPeripheral(b, num(b, address), size, undefined, address);

describe('TIM static bus path', () => {
  it('TIM2 ARR static write/read handles 32-bit and byte lane; dynamic read is parity', async () => {
    const address = TIM2 + ARR;
    const step: (body: Body) => void = (body) => {
      staticWrite(body, address, 4, 0x11223344);
      write(body, 'result0', staticRead(body, address, 4));
      write(body, 'result1', timerModule.read(body, num(body, address), 4));
      staticWrite(body, address + 3, 1, 0xaa);
      write(body, 'result2', staticRead(body, address, 4));
      write(body, 'result3', staticRead(body, address + 3, 1));
      staticWrite(body, address + 2, 2, 0xbbcc);
      write(body, 'result4', staticRead(body, address, 4));
      write(body, 'result5', staticRead(body, address + 2, 2));
      body.redirect(2, 1_000);
    };
    const rig = await createTimRig({ steps: [step, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(rig.state('result0')).toBe(0x11223344);
      expect(rig.state('result1')).toBe(0x11223344);
      expect(rig.state('result2')).toBe(0xaa223344);
      expect(rig.state('result3')).toBe(0xaa);
      expect(rig.state('result4')).toBe(0xbbcc3344);
      expect(rig.state('result5')).toBe(0xbbcc);
    } finally {
      rig.dispose();
    }
  });

  it('TIM2 ARR static write with defer=true commits before read and leaves no deferred request', async () => {
    const address = TIM2 + ARR;
    const step: (body: Body) => void = (body) => {
      staticWrite(body, address, 4, 0x1234, true);
      write(body, 'result0', staticRead(body, address, 4));
      body.redirect(2, 1_000);
    };
    const rig = await createTimRig({ steps: [step, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(rig.state('result0')).toBe(0x1234);
      expect(Number(rig.state('serviceMask')) & SERVICE_DEFER_WRITE).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('TIM3/TIM6, EGR UG, and reserved static writes keep register semantics', async () => {
    const step: (body: Body) => void = (body) => {
      staticWrite(body, TIM3 + ARR, 4, 0x11223344);
      write(body, 'result0', staticRead(body, TIM3 + ARR, 4));

      staticWrite(body, TIM6 + ARR, 4, 0x1234);
      staticWrite(body, TIM6 + PSC, 4, 0x56);
      write(body, 'result1', staticRead(body, TIM6 + ARR, 4));
      write(body, 'result2', staticRead(body, TIM6 + PSC, 4));

      staticWrite(body, TIM2 + EGR, 4, EGR_UG);
      write(body, 'result3', staticRead(body, TIM2 + CNT, 4));
      write(body, 'result4', staticRead(body, TIM2 + SR, 4));

      staticWrite(body, TIM2 + 0x50, 4, 0xdead);
      write(body, 'result5', staticRead(body, TIM2 + ARR, 4));
      body.redirect(2, 1_000);
    };
    const rig = await createTimRig({ steps: [step, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(rig.state('result0')).toBe(0x3344); // TIM3 16-bit mask
      expect(rig.state('result1')).toBe(0x1234); // TIM6 basic ARR
      expect(rig.state('result2')).toBe(0x56); // TIM6 basic PSC
      expect(rig.state('result3')).toBe(0); // UG resets CNT
      expect(Number(rig.state('result4')) & 1).toBe(1); // UIF
      expect(rig.state('result5')).toBe(0xffffffff); // reserved write no alias
    } finally {
      rig.dispose();
    }
  });

  it('static CCR read clears CC1IF through the same capture semantics', async () => {
    const init: (body: Body) => void = (body) => {
      enableClock(body, 'gpioA');
      enableClock(body, 'tim2');
      body.writeState('gpioModer0', num(body, 2 << 30));
      body.writeState('gpioAfr10', num(body, 1 << 28));
      staticWrite(body, TIM2 + ARR, 4, 0xffffffff);
      staticWrite(body, TIM2 + PSC, 4, 0);
      staticWrite(body, TIM2 + CCMR1, 4, 0x1);
      staticWrite(body, TIM2 + CCER, 4, 0x1);
      staticWrite(body, TIM2 + DIER, 4, DIER_CC1IE);
      staticWrite(body, TIM2 + CR1, 4, CR1_CEN);
      body.redirect(2, 1_000);
    };
    const capture: (body: Body) => void = (body) => {
      observeTimerInputByPin(body, 'PA15', num(body, 1_000_000), body.constant(types.bool, true));
      write(body, 'result3', staticRead(body, TIM2 + CCR1, 4));
      write(
        body,
        'result4',
        body.select(
          types.number,
          body.notEqual(
            types.number,
            body.bitAnd(staticRead(body, TIM2 + SR, 4), num(body, 1 << 1)),
            num(body, 0),
          ),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      );
      body.stop();
    };
    const rig = await createTimRig({ steps: [init, capture] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(Number(rig.state('result3'))).toBeGreaterThan(0);
      expect(rig.state('result4')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('SR W0C byte lanes and EGR byte lane keep the dynamic register semantics', async () => {
    const step: (body: Body) => void = (body) => {
      // W0C 无法通过写 1 建立初值：直接写入 TIM2 的 SR 后备，只为验证随后字节写的
      // “选中 lane = old & value，其它 lane 保持”语义。
      const tim2Sr = timerConfigAt(TIM2)!.memoryIndex * TIMER_REGISTER_STRIDE + SR;

      writeWordAt(body, 'tim', tim2Sr, num(body, 0xf0f0));
      staticWrite(body, TIM2 + SR + 1, 1, 0x0f);
      write(body, 'result0', staticRead(body, TIM2 + SR, 4));

      staticWrite(body, TIM2 + CNT, 4, 0x1234);
      staticWrite(body, TIM2 + EGR + 1, 1, EGR_UG);
      write(body, 'result1', staticRead(body, TIM2 + CNT, 4));
      staticWrite(body, TIM2 + EGR, 1, EGR_UG);
      write(body, 'result2', staticRead(body, TIM2 + CNT, 4));
      body.redirect(2, 1_000);
    };
    const rig = await createTimRig({ steps: [step, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(rig.state('result0')).toBe(0x00f0);
      expect(rig.state('result1')).toBe(0x1234); // EGR +1 的 bit0 不是 UG
      expect(rig.state('result2')).toBe(0); // EGR +0 的 bit0 是 UG
    } finally {
      rig.dispose();
    }
  });

  it('basic TIM6/7 reserved registers read zero and never alias ARR', async () => {
    const TIM7 = 0x40001400;
    const step: (body: Body) => void = (body) => {
      staticWrite(body, TIM6 + ARR, 4, 0x1234);
      staticWrite(body, TIM6 + CCR1, 4, 0xdead);
      staticWrite(body, TIM6 + CCMR1, 4, 1);
      staticWrite(body, TIM7 + ARR, 4, 0x2345);
      staticWrite(body, TIM7 + CCR1, 4, 0xbeef);
      write(body, 'result0', staticRead(body, TIM6 + ARR, 4));
      write(body, 'result1', staticRead(body, TIM6 + CCR1, 4));
      write(body, 'result2', staticRead(body, TIM6 + CCMR1, 4));
      write(body, 'result3', staticRead(body, TIM7 + ARR, 4));
      write(body, 'result4', staticRead(body, TIM7 + CCR1, 4));
      body.redirect(2, 1_000);
    };
    const rig = await createTimRig({ steps: [step, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(rig.state('result0')).toBe(0x1234);
      expect(rig.state('result1')).toBe(0);
      expect(rig.state('result2')).toBe(0);
      expect(rig.state('result3')).toBe(0x2345);
      expect(rig.state('result4')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('static TIM2 access lazily initializes only TIM2', async () => {
    const step: (body: Body) => void = (body) => {
      staticWrite(body, TIM2 + ARR, 4, 0x1234);
      write(body, 'result0', staticRead(body, TIM2 + ARR, 4));
      body.redirect(2, 1_000);
    };
    const rig = await createTimRig({ steps: [step, (body) => body.stop()] });

    try {
      rig.runUntil(0);
      rig.runUntil(2_000);

      expect(rig.state('result0')).toBe(0x1234);
      expect(rig.state('tim2Ready')).toBe(1);
      for (const timer of [
        'tim1',
        'tim3',
        'tim4',
        'tim6',
        'tim7',
        'tim8',
        'tim15',
        'tim16',
        'tim17',
      ])
        expect(rig.state(`${timer}Ready`)).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});
