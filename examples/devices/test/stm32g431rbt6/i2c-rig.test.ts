import { describe, expect, it } from 'vitest';
import { i2cDrivers } from '../../../stm32g431rbt6-core/src/i2c';
import { createRig } from './i2c-rig';

describe('I2C 外设专属 rig（真实引脚 + AT24C02/MCP4017）', () => {
  it('完成 EEPROM 写/重复 START 读与 MCP 写/读', async () => {
    const rig = await createRig();

    try {
      // 前 3 ms 用 1 µs 步长，让探针批边界能分辨 SCL 的 5 µs 低/高电平。
      for (let step = 0; step < 3_000; step += 1) rig.run(1_000_000);
      rig.run(37_000_000_000);

      const dump = (await rig.query('eeprom', 'getDump')) as Uint8Array;
      const wiper = (await rig.query('pot', 'getWiper')) as number;

      expect(rig.faults).toEqual([]);
      expect(rig.levels.scl).toContain(0);
      expect(rig.levels.scl).toContain(1);
      expect(rig.levels.pb6.length).toBeGreaterThan(0);
      expect(rig.levels.pb6).not.toContain(0);

      const low: number[] = [];
      const high: number[] = [];
      for (let index = 1; index < rig.levels.scl.length; index += 1) {
        const previous = rig.levels.scl[index - 1];
        const current = rig.levels.scl[index];
        const duration = rig.times.scl[index]! - rig.times.scl[index - 1]!;
        if (previous === 0 && current === 1) low.push(duration);
        if (previous === 1 && current === 0) high.push(duration);
      }
      const lowPeriods = low.filter((duration) => duration > 0);
      const highPeriods = high.filter((duration) => duration > 0);
      expect(lowPeriods.length).toBeGreaterThan(0);
      expect(highPeriods.length).toBeGreaterThan(0);
      // TIMINGR=0x00304F4F：SCLL/SCLH 均为 0x4F，16 MHz 下低/高各 5 µs，
      // 数据位周期 10 µs（100 kHz）。START/STOP 的 hold 会额外拉长个别电平，取中位数。
      const median = (values: readonly number[]): number => {
        const sorted = [...values].sort((left, right) => left - right);

        return sorted[Math.floor(sorted.length / 2)]!;
      };

      const lowMedian = median(lowPeriods);
      const highMedian = median(highPeriods);

      expect(lowMedian).toBeGreaterThanOrEqual(4_500_000);
      expect(lowMedian).toBeLessThanOrEqual(5_500_000);
      expect(highMedian).toBeGreaterThanOrEqual(4_500_000);
      expect(highMedian).toBeLessThanOrEqual(5_500_000);
      expect(lowMedian + highMedian).toBeGreaterThanOrEqual(9_500_000);
      expect(lowMedian + highMedian).toBeLessThanOrEqual(10_500_000);
      expect([...dump.subarray(0, 4)]).toEqual([0x5a, 0x00, 0x00, 0x00]);
      expect(wiper).toBe(0x60);
    } finally {
      rig.dispose();
    }
  });

  it('未知从机地址产生 NACKF 并由 AUTOEND 收尾', async () => {
    const rig = await createRig({ nack: true });

    try {
      for (let step = 0; step < 20; step += 1) rig.run(1_000_000_000);
      expect(rig.faults).toEqual([]);
      expect(rig.state('nack')).toBe(2);
    } finally {
      rig.dispose();
    }
  });

  it('byte/half/word 寄存器访问一致，ISR/TXDR 只读语义保持', async () => {
    const rig = await createRig({ registers: true });

    try {
      rig.run(10_000_000);
      const image = rig.memory('i2c');

      expect(rig.faults).toEqual([]);
      expect(rig.state('result')).toBe(0);
      expect([...image!.subarray(0x00, 0x04)]).toEqual([0x01, 0x00, 0x00, 0x00]);
      expect([...image!.subarray(0x08, 0x10)]).toEqual([
        0x78, 0x56, 0x34, 0x12, 0xcd, 0xab, 0x00, 0x00,
      ]);
      expect([...image!.subarray(0x10, 0x14)]).toEqual([0x4f, 0x4f, 0x30, 0x00]);
      expect([...image!.subarray(0x18, 0x1c)]).toEqual([0, 0, 0, 0]);
    } finally {
      rig.dispose();
    }
  });

  it('PB6 配置为 AF4 也不会被 I2C1 驱动 SCL（G431 硅片事实）', () => {
    expect(i2cDrivers().some((driver) => driver.port === 1 && driver.pin === 6)).toBe(false);
  });

  it('超过 4.295 ms 的相位不以 32 位 ps 截断', async () => {
    const rig = await createRig({ time: true, clockFrequency: 1_000 });

    try {
      rig.run(1_000_000_000);
      // 4.096 s / 1 ms per cycle = 4096 cycles；5 ms 只消耗约 5 个周期。
      expect(rig.state('remaining')).toBeGreaterThan(4_000);
      expect(rig.state('remaining')).toBeLessThan(4_096);
    } finally {
      rig.dispose();
    }
  });

  it('保留窗口不别名真实寄存器，RXDR/TXDR 只对低 byte lane 生效，PECR 只读', async () => {
    const rig = await createRig({ guards: true });

    try {
      rig.run(10_000_000);
      expect(rig.faults).toEqual([]);
      expect(rig.state('g9')).toBe(1); // 0x40 写没有清掉 CR1.PE
      expect(rig.state('g6')).toBe(1); // 0x29 写没有置 TX_LOADED
      expect(rig.state('g7')).toBe(0x5a); // 0x28 有效写入了 TXDR
      expect(rig.state('g8')).toBe(0); // PECR 写被忽略
      expect(rig.state('g0')).toBe(0); // 0x25 读不返回 RXDR
      expect(rig.state('g4')).toBe(2); // 0x25 读不清 RXNE
      expect(rig.state('g1')).toBe(0x77); // 0x24 读返回 RXDR
      expect(rig.state('g5')).toBe(0); // 0x24 读清 RXNE
      expect(rig.state('g2')).toBe(0); // 0x58 不别名 ISR
      expect(rig.state('g3')).toBe(0); // 0x40 不别名 CR1
    } finally {
      rig.dispose();
    }
  });

  it('分 50 次 100 µs 推进与一次 5 ms 推进等价（余数不丢失）', async () => {
    const once = await createRig({ time: true, clockFrequency: 1_000 });
    const split = await createRig({ timeSplit: true, clockFrequency: 1_000 });

    try {
      once.run(1_000_000_000);
      for (let step = 0; step < 4_000; step += 1) split.run(1_000_000);
      expect(split.state('remaining')).toBe(once.state('remaining'));
      expect(split.state('fraction')).toBe(0);
    } finally {
      once.dispose();
      split.dispose();
    }
  });

  it('I2C1 时钟取自 RCC 缓存（8 MHz 时 0x00304F4F 的低/高各 10 µs）', async () => {
    const rig = await createRig({ clockHz: 8_000_000 });

    try {
      for (let step = 0; step < 3_000; step += 1) rig.run(1_000_000);
      rig.run(37_000_000_000);

      const lows: number[] = [];
      const highs: number[] = [];
      for (let index = 1; index < rig.levels.scl.length; index += 1) {
        const duration = rig.times.scl[index]! - rig.times.scl[index - 1]!;
        if (rig.levels.scl[index - 1] === 0 && rig.levels.scl[index] === 1) lows.push(duration);
        if (rig.levels.scl[index - 1] === 1 && rig.levels.scl[index] === 0) highs.push(duration);
      }
      const median = (values: readonly number[]): number => {
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.floor(sorted.length / 2)]!;
      };
      expect(median(lows.filter((value) => value > 0))).toBeGreaterThanOrEqual(9_000_000);
      expect(median(lows.filter((value) => value > 0))).toBeLessThanOrEqual(11_000_000);
      expect(median(highs.filter((value) => value > 0))).toBeGreaterThanOrEqual(9_000_000);
      expect(median(highs.filter((value) => value > 0))).toBeLessThanOrEqual(11_000_000);
    } finally {
      rig.dispose();
    }
  });
});
