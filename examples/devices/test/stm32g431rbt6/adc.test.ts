import { describe, expect, it } from 'vitest';
import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  ADC12_COMMON_BASE,
  ADC1_BASE,
  ADC2_BASE,
  ADCS,
  ADC_CCR,
  ADC_CFGR,
  ADC_CR,
  ADC_DR,
  ADC_IER,
  ADC_ISR,
  ADC_ISR_ADRDY,
  ADC_ISR_EOC,
  ADC_ISR_EOS,
  ADC_ISR_OVR,
  ADC_SQR1,
  ADC_CFGR_OVRMOD,
  ADC_SMPR2,
  adcActive,
  adcPending,
  advanceAdc,
  readAdc,
  readAdcAddressAt,
  writeAdc,
  writeAdcAddressAt,
} from '@mica-js/stm32g431rbt6-core/adc';
import { boolBit, num } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import { writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import { runAdcRig } from './adc-rig';

const OUT_DR = 0x00;
const OUT_ISR = 0x04;
const OUT_ACTIVE = 0x08;
const OUT_CODE = 0x0c;
const OUT_FLAG = 0x10;
const OUT_ADRDY = 0x14;

const put = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, 'out', offset, value);
};

const putFlag = (b: Body, offset: number, set: Value<boolean>): void => {
  put(
    b,
    offset,
    b.select(
      types.number,
      set,
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );
};

const write = (b: Body, address: number, value: number | Value<number>): void => {
  writeAdcAddressAt(b, address, 4, typeof value === 'number' ? num(b, value) : value);
};

const read = (b: Body, address: number): Value<number> =>
  readAdcAddressAt(b, address, 4);

/** 打开 ADC 的稳压器、模拟模式、同步时钟与 ADEN。 */
function enableAdc1(b: Body): void {
  b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 30)));
  write(b, ADC12_COMMON_BASE + ADC_CCR, 1 << 16);
  write(b, ADC1_BASE + ADC_CR, 1 << 28);
  write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1);
}

function basicFirmware(): (b: Body) => void {
  return (b) => {
    enableAdc1(b);
    put(b, OUT_ADRDY, read(b, ADC1_BASE + ADC_ISR));
    write(b, ADC1_BASE + ADC_CFGR, 0);
    write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
    write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
    putFlag(b, OUT_ACTIVE, adcActive(b));
    advanceAdc(b, num(b, 400_000));
    putFlag(b, OUT_FLAG, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOC));
    advanceAdc(b, num(b, 700_000));
    put(b, OUT_ISR, read(b, ADC1_BASE + ADC_ISR));
    put(b, OUT_DR, read(b, ADC1_BASE + ADC_DR));
    put(b, OUT_CODE, read(b, ADC1_BASE + ADC_DR));
  };
}

describe('ADC1/2 规则组模型（IR rig）', () => {
  it('ADC1_IN11 (PB12) 从真实电阻分压得到 12 位码，并按时序置 EOC/EOS', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: basicFirmware(),
    });

    try {
      const out = new DataView(rig.memory('out').buffer);
      const adrdy = out.getUint32(OUT_ADRDY, true);

      expect(adrdy & ADC_ISR_ADRDY).toBe(ADC_ISR_ADRDY);
      expect(out.getUint32(OUT_ACTIVE, true)).toBe(1);
      // 部分推进不足一个转换周期，EOC 仍为 0；完整推进后 EOC/EOS 置位。
      expect(out.getUint32(OUT_FLAG, true)).toBe(0);
      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_EOC).toBe(ADC_ISR_EOC);
      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_EOS).toBe(ADC_ISR_EOS);
      // 1/2 VDD / VREFP = 0.5 → round(0.5 × 4095) = 2048。
      expect(out.getUint32(OUT_DR, true)).toBe(2048);
    } finally {
      rig.dispose();
    }
  });

  it('ADC2_IN15 (PB15) 使用 1/4 分压得到 1024', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PB15', top: 30_000, bottom: 10_000 }],
      build: (b) => {
        b.writeState('gpioModer1', num(b, 3 << 30));
        write(b, ADC12_COMMON_BASE + ADC_CCR, 1 << 16);
        write(b, ADC2_BASE + ADC_CR, 1 << 28);
        write(b, ADC2_BASE + ADC_CR, (1 << 28) | 1);
        write(b, ADC2_BASE + ADC_CFGR, 0);
        write(b, ADC2_BASE + ADC_SQR1, 15 << 6);
        write(b, ADC2_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        putFlag(b, OUT_FLAG, boolBit(b, read(b, ADC2_BASE + ADC_ISR), ADC_ISR_EOC));
        put(b, OUT_CODE, read(b, ADC2_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_FLAG, true)).toBe(1);
      expect(out.getUint32(OUT_CODE, true)).toBe(1024);
    } finally {
      rig.dispose();
    }
  });

  it('12/10/8/6 位与左右对齐的码值按 RM 映射', () => {
    for (const [res, align, expected] of [
      [0, 0, 2048],
      [0, 1, 2048 << 4],
      [1, 0, 512],
      [1, 1, 512 << 6],
      [2, 0, 128],
      [2, 1, 128 << 8],
      [3, 0, 32],
      [3, 1, 32 << 10],
    ] as const) {
      const rig = runAdcRig({
        dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
        build: (b) => {
          enableAdc1(b);
          write(b, ADC1_BASE + ADC_CFGR, (res << 3) | (align << 15));
          write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
          write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
          advanceAdc(b, num(b, 1_000_000));
          put(b, OUT_CODE, read(b, ADC1_BASE + ADC_DR));
        },
      });

      try {
        expect(new DataView(rig.memory('out').buffer).getUint32(OUT_CODE, true)).toBe(expected);
      } finally {
        rig.dispose();
      }
    }
  });

  it('多 rank 扫描只在最后一个 rank 置 EOS，DR 读清除 EOC', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PB12', top: 10_000, bottom: 10_000 },
        { pin: 'PB14', top: 30_000, bottom: 10_000 },
      ],
      build: (b) => {
        enableAdc1(b);
        b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 28) | (3 << 30)));
        // L=1（2 ranks），SQ1=IN11（PB12），SQ2=IN5（PB14）。
        write(b, ADC1_BASE + ADC_SQR1, 1 | (11 << 6) | (5 << 12));
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        put(b, OUT_ISR, read(b, ADC1_BASE + ADC_ISR));
        put(b, OUT_DR, read(b, ADC1_BASE + ADC_DR));
        advanceAdc(b, num(b, 1_000_000));
        put(b, 0x1c, read(b, ADC1_BASE + ADC_ISR));
        put(b, 0x18, read(b, ADC1_BASE + ADC_DR));
        put(b, 0x20, read(b, ADC1_BASE + ADC_ISR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      // 第一个 rank：1/2 VDD = 2048；EOC 置位，EOS 尚未置位。
      expect(out.getUint32(OUT_DR, true)).toBe(2048);
      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_EOC).toBe(ADC_ISR_EOC);
      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_EOS).toBe(0);
      // 第二个 rank：1/4 VDD = 1024；EOC 在 DR 读后清除，EOS 保持。
      expect(out.getUint32(0x18, true)).toBe(1024);
      expect(out.getUint32(0x1c, true) & ADC_ISR_EOC).toBe(ADC_ISR_EOC);
      expect(out.getUint32(0x20, true) & ADC_ISR_EOC).toBe(0);
      expect(out.getUint32(0x20, true) & ADC_ISR_EOS).toBe(ADC_ISR_EOS);
    } finally {
      rig.dispose();
    }
  });

  it('未读 DR 时第二次完成置 OVR，OVRMOD=0 保留旧数据', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PB12', top: 10_000, bottom: 10_000 },
        { pin: 'PB14', top: 30_000, bottom: 10_000 },
      ],
      build: (b) => {
        enableAdc1(b);
        b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 28) | (3 << 30)));
        write(b, ADC1_BASE + ADC_SQR1, 1 | (11 << 6) | (5 << 12));
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        // 第一 rank 完成，EOC 置位且未读 DR；第二次完成必须置 OVR 并保留旧数据。
        advanceAdc(b, num(b, 1_000_000));
        put(b, OUT_ISR, read(b, ADC1_BASE + ADC_ISR));
        put(b, OUT_CODE, read(b, ADC1_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_OVR).toBe(ADC_ISR_OVR);
      // OVRMOD=0 保留旧 DR（第一 rank 的 2048），不写入第二 rank 的 1024。
      expect(out.getUint32(OUT_CODE, true)).toBe(2048);
    } finally {
      rig.dispose();
    }
  });

  it('VREFP 浮空时不产生 EOC/DR，并中止 ADSTART', () => {
    const rig = runAdcRig({
      floatingReference: true,
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        enableAdc1(b);
        write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        put(b, OUT_ISR, read(b, ADC1_BASE + ADC_ISR));
        put(b, OUT_DR, read(b, ADC1_BASE + ADC_DR));
        put(b, 0x18, read(b, ADC1_BASE + ADC_CR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_EOC).toBe(0);
      expect(out.getUint32(OUT_DR, true)).toBe(0);
      expect(out.getUint32(0x18, true) & (1 << 2)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('VDDA 未上电时 ADEN 不置 ADRDY，也不启动转换', () => {
    const rig = runAdcRig({
      unpoweredAnalog: true,
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        b.writeState('gpioModer1', num(b, 3 << 24));
        write(b, ADC12_COMMON_BASE + ADC_CCR, 1 << 16);
        write(b, ADC1_BASE + ADC_CR, 1 << 28);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1);
        put(b, OUT_ADRDY, read(b, ADC1_BASE + ADC_ISR));
        write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        putFlag(b, OUT_ACTIVE, adcActive(b));
        advanceAdc(b, num(b, 1_000_000));
        put(b, OUT_ISR, read(b, ADC1_BASE + ADC_ISR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_ADRDY, true) & ADC_ISR_ADRDY).toBe(0);
      expect(out.getUint32(OUT_ACTIVE, true)).toBe(0);
      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_EOC).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('外部通道要求 GPIO MODER=11；数字模式不产生数据', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        // 只把 PB15 配成模拟，PB12 保持数字输入。
        b.writeState('gpioModer1', num(b, 3 << 30));
        write(b, ADC12_COMMON_BASE + ADC_CCR, 1 << 16);
        write(b, ADC1_BASE + ADC_CR, 1 << 28);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1);
        write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        put(b, OUT_ISR, read(b, ADC1_BASE + ADC_ISR));
        put(b, OUT_DR, read(b, ADC1_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_EOC).toBe(0);
      expect(out.getUint32(OUT_DR, true)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('EOCIE 使能后完成转换会置 irqDirty，清 ISR 后挂起解除', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        enableAdc1(b);
        write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
        write(b, ADC1_BASE + ADC_IER, 1 << 2); // IER.EOCIE
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        putFlag(b, OUT_FLAG, adcPending(b, ADCS[0]!));
        putFlag(b, 0x18, b.readState('irqDirty', types.bool));
        write(b, ADC1_BASE + ADC_ISR, ADC_ISR_EOC);
        putFlag(b, 0x1c, adcPending(b, ADCS[0]!));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_FLAG, true)).toBe(1);
      expect(out.getUint32(0x18, true)).toBe(1);
      expect(out.getUint32(0x1c, true)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('理想 ADC 边界 LSB：0 V→0、1 LSB→1、4095/4096 VREF→4095', () => {
    for (const [top, bottom, expected] of [
      [1_000_000_000, 1, 0],
      [4_095, 1, 1],
      [1, 4_095, 4095],
    ] as const) {
      const rig = runAdcRig({
        dividers: [{ pin: 'PB12', top, bottom }],
        build: (b) => {
          enableAdc1(b);
          write(b, ADC1_BASE + ADC_CFGR, 0);
          write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
          write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
          advanceAdc(b, num(b, 1_000_000));
          put(b, OUT_CODE, read(b, ADC1_BASE + ADC_DR));
        },
      });

      try {
        expect(new DataView(rig.memory('out').buffer).getUint32(OUT_CODE, true)).toBe(expected);
      } finally {
        rig.dispose();
      }
    }
  });

  it('OVRMOD=1 覆盖 DR 时仍置 OVR', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PB12', top: 10_000, bottom: 10_000 },
        { pin: 'PB14', top: 30_000, bottom: 10_000 },
      ],
      build: (b) => {
        enableAdc1(b);
        b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 28) | (3 << 30)));
        write(b, ADC1_BASE + ADC_CFGR, ADC_CFGR_OVRMOD);
        write(b, ADC1_BASE + ADC_SQR1, 1 | (11 << 6) | (5 << 12));
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        advanceAdc(b, num(b, 1_000_000));
        put(b, OUT_ISR, read(b, ADC1_BASE + ADC_ISR));
        put(b, OUT_CODE, read(b, ADC1_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_ISR, true) & ADC_ISR_OVR).toBe(ADC_ISR_OVR);
      expect(out.getUint32(OUT_CODE, true)).toBe(1024);
    } finally {
      rig.dispose();
    }
  });

  it('读 DR 高位保留字节不清 EOC；读低半字才清 EOC', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        enableAdc1(b);
        write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        // 高字节 / 高半字只读保留位。
        putFlag(
          b,
          0x00,
          boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOC),
        );
        readAdcAddressAt(b, ADC1_BASE + ADC_DR + 2, 1);
        putFlag(b, 0x04, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOC));
        readAdcAddressAt(b, ADC1_BASE + ADC_DR, 2);
        putFlag(b, 0x08, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOC));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(1);
      expect(out.getUint32(0x04, true)).toBe(1);
      expect(out.getUint32(0x08, true)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('保留寄存器读写无效；IER 高位保留位被屏蔽', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        enableAdc1(b);
        write(b, ADC1_BASE + 0x1c, 0xdeadbeef);
        put(b, 0x00, read(b, ADC1_BASE + 0x1c));
        // IER 字节写：只允许低 11 位。
        writeAdcAddressAt(b, ADC1_BASE + 0x04, 1, num(b, 0x04));
        writeAdcAddressAt(b, ADC1_BASE + 0x05, 1, num(b, 0xf8));
        put(b, 0x04, read(b, ADC1_BASE + 0x04));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(0);
      expect(out.getUint32(0x04, true)).toBe(0x04);
    } finally {
      rig.dispose();
    }
  });

  it('运行期偏移的 readAdc/writeAdc 与静态路径一致', () => {
    const rig = runAdcRig({
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        enableAdc1(b);
        write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 1_000_000));
        // 用 GPIO 影子 state 承载运行期偏移，禁止翻译期常量折叠。
        b.writeState('gpioModer2', num(b, 0x00));
        const offset = b.readState('gpioModer2', types.number);
        put(b, 0x00, readAdc(b, ADCS[0]!, offset, 4));
        writeAdc(b, ADCS[0]!, offset, 4, num(b, ADC_ISR_EOC));
        put(b, 0x04, readAdc(b, ADCS[0]!, offset, 4));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true) & ADC_ISR_EOC).toBe(ADC_ISR_EOC);
      expect(out.getUint32(0x04, true) & ADC_ISR_EOC).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('低频 + 最大采样时 64 位剩余时间不截断', () => {
    const rig = runAdcRig({
      clockFrequency: 1_000,
      dividers: [{ pin: 'PB12', top: 10_000, bottom: 10_000 }],
      build: (b) => {
        b.writeState('gpioModer1', num(b, 3 << 24));
        // 异步 ADC 时钟 PRESC=256；ch11 SMP=640.5 周期。
        write(b, ADC12_COMMON_BASE + ADC_CCR, 10 << 18);
        write(b, ADC1_BASE + ADC_CR, 1 << 28);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1);
        write(b, ADC1_BASE + ADC_CFGR, 0);
        write(b, ADC1_BASE + ADC_SMPR2, 7 << 3);
        write(b, ADC1_BASE + ADC_SQR1, 11 << 6);
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 100_000_000_000_000));
        putFlag(b, 0x00, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOC));
        advanceAdc(b, num(b, 70_000_000_000_000));
        putFlag(b, 0x04, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOC));
        put(b, 0x08, read(b, ADC1_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(0);
      expect(out.getUint32(0x04, true)).toBe(1);
      expect(out.getUint32(0x08, true)).toBe(2048);
    } finally {
      rig.dispose();
    }
  });

  it('单次长 advance 完成多个 rank（不丢后续事件）', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PB12', top: 10_000, bottom: 10_000 },
        { pin: 'PB14', top: 30_000, bottom: 10_000 },
      ],
      build: (b) => {
        enableAdc1(b);
        b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 28) | (3 << 30)));
        write(b, ADC1_BASE + ADC_CFGR, ADC_CFGR_OVRMOD);
        write(b, ADC1_BASE + ADC_SQR1, 1 | (11 << 6) | (5 << 12));
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        // 2.2 µs 覆盖两个 937.5 ns rank。
        advanceAdc(b, num(b, 2_200_000));
        putFlag(b, 0x00, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOS));
        put(b, 0x04, read(b, ADC1_BASE + ADC_DR));
        put(b, 0x08, read(b, ADC1_BASE + ADC_ISR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(1);
      expect(out.getUint32(0x04, true)).toBe(1024);
      expect(out.getUint32(0x08, true) & ADC_ISR_OVR).toBe(ADC_ISR_OVR);
    } finally {
      rig.dispose();
    }
  });

  it('单次 advance 可完成 4 rank 序列', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PB12', top: 10_000, bottom: 10_000 },
        { pin: 'PB14', top: 30_000, bottom: 10_000 },
      ],
      build: (b) => {
        enableAdc1(b);
        b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 28) | (3 << 30)));
        write(b, ADC1_BASE + ADC_CFGR, ADC_CFGR_OVRMOD);
        // L=3：4 ranks，11/5/11/5。
        write(b, ADC1_BASE + ADC_SQR1, 3 | (11 << 6) | (5 << 12) | (11 << 18) | (5 << 24));
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 4_500_000));
        putFlag(b, 0x00, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOS));
        put(b, 0x04, read(b, ADC1_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(1);
      expect(out.getUint32(0x04, true)).toBe(1024);
    } finally {
      rig.dispose();
    }
  });

  it('6 rank 长步跨两次 advance 仍完成全部事件', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PB12', top: 10_000, bottom: 10_000 },
        { pin: 'PB14', top: 30_000, bottom: 10_000 },
      ],
      build: (b) => {
        enableAdc1(b);
        b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 28) | (3 << 30)));
        write(b, ADC1_BASE + ADC_CFGR, ADC_CFGR_OVRMOD);
        // L=5：6 ranks；SQR1 ranks1-4，SQR2 ranks5-6。
        write(
          b,
          ADC1_BASE + ADC_SQR1,
          5 | (11 << 6) | (5 << 12) | (11 << 18) | (5 << 24),
        );
        write(b, ADC1_BASE + 0x34, 11 | (5 << 6));
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        advanceAdc(b, num(b, 6_500_000));
        advanceAdc(b, num(b, 1));
        putFlag(b, 0x00, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOS));
        put(b, 0x04, read(b, ADC1_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(1);
      expect(out.getUint32(0x04, true)).toBe(1024);
    } finally {
      rig.dispose();
    }
  });

  it('长 advance 的 overshoot 结转到下一 rank，不重置整段时长', () => {
    const rig = runAdcRig({
      dividers: [
        { pin: 'PB12', top: 10_000, bottom: 10_000 },
        { pin: 'PB14', top: 30_000, bottom: 10_000 },
      ],
      build: (b) => {
        enableAdc1(b);
        b.writeState('gpioModer1', num(b, (3 << 24) | (3 << 28) | (3 << 30)));
        write(b, ADC1_BASE + ADC_SQR1, 1 | (11 << 6) | (5 << 12));
        write(b, ADC1_BASE + ADC_CR, (1 << 28) | 1 | (1 << 2));
        // 每 rank 937.5 ns；1.5 µs 完成 rank0 并结转 562.5 ns。
        advanceAdc(b, num(b, 1_500_000));
        putFlag(b, 0x00, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOS));
        read(b, ADC1_BASE + ADC_DR);
        advanceAdc(b, num(b, 400_000));
        putFlag(b, 0x04, boolBit(b, read(b, ADC1_BASE + ADC_ISR), ADC_ISR_EOS));
        put(b, 0x08, read(b, ADC1_BASE + ADC_DR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(0);
      expect(out.getUint32(0x04, true)).toBe(1);
      expect(out.getUint32(0x08, true)).toBe(1024);
    } finally {
      rig.dispose();
    }
  });
});
