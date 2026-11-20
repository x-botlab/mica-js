import { describe, expect, it } from 'vitest';
import { types } from '@mica-js/sdk/model';
import { ADC2_PINS } from '@mica-js/stm32g431rbt6-core/adc-layout';
import {
  ADC12_COMMON_BASE,
  ADC2_BASE,
  ADC_CCR,
  ADC_CR,
  ADC_DR,
  ADC_ISR,
  ADC_SQR1,
  advanceAdc,
  readAdcAddressAt,
  writeAdcAddressAt,
} from '@mica-js/stm32g431rbt6-core/adc';
import {
  DAC1_BASE,
  DAC_CR,
  DAC_DHR12R1,
  DAC_DOR1,
  advanceDac,
  readDacAt,
  writeDacAt,
} from '@mica-js/stm32g431rbt6-core/dac';
import { readComparatorAt, writeComparatorAt } from '@mica-js/stm32g431rbt6-core/comparator';
import { advanceOpamp, writeOpampAt } from '@mica-js/stm32g431rbt6-core/opamp';
import { boolBit, num, writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { runAdcRig } from './adc-rig';

/** 让板级电气求解在下一段 IR 之前落地。 */
const settle = (b: Body): void => {
  (b as unknown as { wait(ps: number): void }).wait(1_000_000);
};

const put = (b: Body, offset: number, value: ReturnType<typeof num>): void => {
  writeWordAt(b, 'out', offset, value);
};

const putFlag = (b: Body, offset: number, value: ReturnType<typeof boolBit>): void => {
  put(
    b,
    offset,
    b.select(
      types.number,
      value,
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );
};

const write = (b: Body, address: number, value: number | ReturnType<typeof num>): void => {
  writeAdcAddressAt(b, address, 4, typeof value === 'number' ? num(b, value) : value);
};

describe('模拟外设可行模型（IR rig）', () => {
  it('DAC1 输出经 PA4 分压后被 ADC2_IN17 读回 2048', () => {
    const rig = runAdcRig({
      build: (b) => {
        // DAC1: EN1=1，12 位右对齐 2048 → 1.65 V。
        b.writeState('gpioModer0', num(b, 3 << 8));
        writeDacAt(b, DAC1_BASE + DAC_CR, 4, num(b, 1));
        writeDacAt(b, DAC1_BASE + DAC_DHR12R1, 4, num(b, 2048));
        settle(b);
        advanceDac(b);

        // PA4 = 模拟输入，ADC2_IN17。
        write(b, ADC12_COMMON_BASE + ADC_CCR, 1 << 16);
        write(b, ADC2_BASE + ADC_CR, (1 << 28) | 1);
        write(b, ADC2_BASE + ADC_SQR1, 17 << 6);
        write(b, ADC2_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        putFlag(b, 0x00, boolBit(b, readAdcAddressAt(b, ADC2_BASE + ADC_ISR, 4), 1 << 2));
        put(b, 0x04, readAdcAddressAt(b, ADC2_BASE + ADC_DR, 4));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(1);
      expect(out.getUint32(0x04, true)).toBe(2048);
    } finally {
      rig.dispose();
    }
  });

  it('COMP1 外部 INM=PA0 / INP=PA1 比较结果写入 CSR.VALUE', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PA0', top: 30_000, bottom: 10_000 },
        { pin: 'PA1', top: 10_000, bottom: 10_000 },
      ],
      build: (b) => {
        b.writeState('gpioModer0', num(b, (3 << 0) | (3 << 2)));
        // EN=1，INMSEL=8（外部 INM0=PA0），INPSEL=0（INP0=PA1）。
        writeComparatorAt(b, 0, 0, 4, num(b, 1 | (7 << 4)));
        settle(b);
        put(b, 0x00, readComparatorAt(b, 0, 0, 4));
      },
    });

    try {
      const csr = new DataView(rig.memory('out').buffer).getUint32(0x00, true);

      expect((csr >>> 30) & 1).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('OPAMP1 follower 把 PA1 的 1.65 V 输出到 PA2', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PA1', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        b.writeState('gpioModer0', num(b, (3 << 2) | (3 << 4)));
        // EN=1，VMSEL=11（follower），VPSEL=00（PA1）。
        writeOpampAt(b, 0, 0, 4, num(b, 1 | (3 << 5)));
        settle(b);
      },
    });

    try {
      const sample = rig.pinSample('PA2') as { voltage: number | null; status: string };
      expect(sample.status).toBe('valid');
      expect(sample.voltage).toBeCloseTo(1.65, 3);
    } finally {
      rig.dispose();
    }
  });

  it('DAC 4096 分母：满码 4095 输出 4095/4096 VREFP', () => {
    const rig = runAdcRig({
      build: (b) => {
        b.writeState('gpioModer0', num(b, 3 << 8));
        writeDacAt(b, DAC1_BASE + DAC_CR, 4, num(b, 1));
        writeDacAt(b, DAC1_BASE + DAC_DHR12R1, 4, num(b, 4095));
        settle(b);
        advanceDac(b);
      },
    });

    try {
      const sample = rig.pinSample('PA4') as { voltage: number | null; status: string };

      expect(sample.status).toBe('valid');
      expect(sample.voltage).toBeCloseTo((3.3 * 4095) / 4096, 6);
    } finally {
      rig.dispose();
    }
  });

  it('DAC 输出电阻固定 10 kΩ：10 kΩ 负载把 1.65 V 拉到 0.825 V', () => {
    const rig = runAdcRig({
      loads: [{ pin: 'PA4', resistance: 10_000 }],
      build: (b) => {
        b.writeState('gpioModer0', num(b, 3 << 8));
        writeDacAt(b, DAC1_BASE + DAC_CR, 4, num(b, 1));
        writeDacAt(b, DAC1_BASE + DAC_DHR12R1, 4, num(b, 2048));
        settle(b);
        advanceDac(b);
      },
    });

    try {
      const sample = rig.pinSample('PA4') as { voltage: number | null; status: string };

      expect(sample.status).toBe('valid');
      expect(sample.voltage).toBeCloseTo(0.825, 5);
    } finally {
      rig.dispose();
    }
  });

  it('OPAMP 关闭后释放 PA2，不继续驱动', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PA1', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        b.writeState('gpioModer0', num(b, (3 << 2) | (3 << 4)));
        writeOpampAt(b, 0, 0, 4, num(b, 1 | (3 << 5)));
        settle(b);
        writeOpampAt(b, 0, 0, 4, num(b, 0));
        settle(b);
      },
    });

    try {
      const sample = rig.pinSample('PA2') as { voltage: number | null; status: string };

      expect(sample.status).toBe('floating');
    } finally {
      rig.dispose();
    }
  });

  it('OPAMP follower 随输入从 0.825 V 跟到 1.65 V', () => {
    const rig = runAdcRig({
      sources: [{ pin: 'PA1', initial: 0 }],
      onTick: (b) => advanceOpamp(b),
      build: (b) => {
        b.writeState('gpioModer0', num(b, (3 << 2) | (3 << 4)));
        writeOpampAt(b, 0, 0, 4, num(b, 1 | (3 << 5)));
        settle(b);
      },
    });

    try {
      let sample = rig.pinSample('PA2') as { voltage: number | null; status: string };

      expect(sample.status).toBe('valid');
      expect(sample.voltage).toBeCloseTo(0.825, 4);

      rig.inputs.PA1!.send(1);
      rig.board.runUntil(rig.board.time + 10_000_000);
      sample = rig.pinSample('PA2') as { voltage: number | null; status: string };
      expect(sample.voltage).toBeCloseTo(1.65, 4);
    } finally {
      rig.dispose();
    }
  });

  it('OPAMP 在 VREFP 掉电后释放输出', () => {
    const rig = runAdcRig({
      sources: [{ pin: 'VREFP', initial: 3 }],
      dividers: [{ pin: 'PA1', top: 10_000, bottom: 10_000 }],
      onTick: (b) => advanceOpamp(b),
      build: (b) => {
        b.writeState('gpioModer0', num(b, (3 << 2) | (3 << 4)));
        writeOpampAt(b, 0, 0, 4, num(b, 1 | (3 << 5)));
        settle(b);
      },
    });

    try {
      expect((rig.pinSample('PA2') as { voltage: number }).voltage).toBeCloseTo(1.65, 4);
      rig.inputs.VREFP!.send(4);
      rig.board.runUntil(rig.board.time + 10_000_000);
      expect((rig.pinSample('PA2') as { status: string }).status).toBe('floating');
    } finally {
      rig.dispose();
    }
  });

  it('DAC 在 VREFP 掉电后释放输出', () => {
    const rig = runAdcRig({
      sources: [{ pin: 'VREFP', initial: 3 }],
      onTick: (b) => advanceDac(b),
      build: (b) => {
        b.writeState('gpioModer0', num(b, 3 << 8));
        writeDacAt(b, DAC1_BASE + DAC_CR, 4, num(b, 1));
        writeDacAt(b, DAC1_BASE + DAC_DHR12R1, 4, num(b, 2048));
        settle(b);
      },
    });

    try {
      expect((rig.pinSample('PA4') as { voltage: number }).voltage).toBeCloseTo(1.65, 4);
      rig.inputs.VREFP!.send(4);
      rig.board.runUntil(rig.board.time + 10_000_000);
      expect((rig.pinSample('PA4') as { status: string }).status).toBe('floating');
    } finally {
      rig.dispose();
    }
  });

  it('COMP LOCK 后配置写入被忽略', () => {
    const rig = runAdcRig({
      build: (b) => {
        writeComparatorAt(b, 0, 0, 4, num(b, 1 | (7 << 4) | (1 << 31)));
        writeComparatorAt(b, 0, 0, 4, num(b, 0));
        put(b, 0x00, readComparatorAt(b, 0, 0, 4));
      },
    });

    try {
      const csr = new DataView(rig.memory('out').buffer).getUint32(0x00, true);

      expect(csr & 1).toBe(1);
      expect(csr & (1 << 31)).toBe(1 << 31);
      expect((csr >>> 4) & 0xf).toBe(7);
    } finally {
      rig.dispose();
    }
  });

  it('ADC2 通道表确认 IN17=PA4、IN15=PB15、IN5=PC4', () => {
    expect(ADC2_PINS[17]?.pin).toBe('PA4');
    expect(ADC2_PINS[15]?.pin).toBe('PB15');
    expect(ADC2_PINS[5]?.pin).toBe('PC4');
  });

  it('DAC 写 DHR 后 DOR 立即更新（TEN=0）', () => {
    const rig = runAdcRig({
      build: (b) => {
        writeDacAt(b, DAC1_BASE + DAC_CR, 4, num(b, 1));
        writeDacAt(b, DAC1_BASE + DAC_DHR12R1, 4, num(b, 0xabc));
        put(b, 0x00, readDacAt(b, DAC1_BASE + DAC_DOR1, 4));
      },
    });

    try {
      expect(new DataView(rig.memory('out').buffer).getUint32(0x00, true)).toBe(0xabc);
    } finally {
      rig.dispose();
    }
  });
});
