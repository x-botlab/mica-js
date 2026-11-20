import { describe, expect, it } from 'vitest';
import { createSpiRig } from './spi-rig';

describe('SPI 外设专属 rig（PA7–PA6 真实回环）', () => {
  it('8 位 CPOL=0/CPHA=0 全双工移位', async () => {
    const rig = await createSpiRig({ cr1: 0x7c, cr2: 0x0700, data: 0x5a, size: 1 });

    try {
      for (let step = 0; step < 20; step += 1) rig.run(1_000_000_000);
      expect(rig.faults).toEqual([]);
      expect(rig.result()).toBe(0x5a);
    } finally {
      rig.dispose();
    }
  });

  it('16 位 CPOL=1/CPHA=1 全双工移位', async () => {
    const rig = await createSpiRig({ cr1: 0x7f, cr2: 0x0f00, data: 0xa55a, size: 2 });

    try {
      for (let step = 0; step < 30; step += 1) rig.run(1_000_000_000);
      expect(rig.faults).toEqual([]);
      expect(rig.result()).toBe(0xa55a);
    } finally {
      rig.dispose();
    }
  });

  it('LSBFIRST 下 8 位回环仍得到原字节', async () => {
    const rig = await createSpiRig({ cr1: 0xfc, cr2: 0x0700, data: 0x81, size: 1 });

    try {
      for (let step = 0; step < 20; step += 1) rig.run(1_000_000_000);
      expect(rig.faults).toEqual([]);
      expect(rig.result()).toBe(0x81);
    } finally {
      rig.dispose();
    }
  });

  it('未读 RXDR 时第二帧完成置 OVR', async () => {
    const rig = await createSpiRig({ cr1: 0x7c, cr2: 0x0700, data: 0x11, second: 0x22, size: 1 });

    try {
      for (let step = 0; step < 30; step += 1) rig.run(1_000_000_000);
      expect(rig.faults).toEqual([]);
      expect(rig.result()).toBe(3);
    } finally {
      rig.dispose();
    }
  });

  it('低核时钟高 BR 的半周期不作 32 位 ps 截断', async () => {
    // 1 kHz、BR=111：半周期 = 128 × 1 ms = 128 ms，远超 4.295 ms。
    const rig = await createSpiRig({
      cr1: 0x7c,
      cr2: 0x0700,
      data: 0x5a,
      size: 1,
      clockFrequency: 1_000,
      time: true,
    });

    try {
      rig.run(1_000_000_000);
      expect(rig.result()).toBeGreaterThan(100);
      expect(rig.result()).toBeLessThan(128);
    } finally {
      rig.dispose();
    }
  });

  it('保留窗口/高 byte lane 不别名，OVR 只在 DR→SR 后清除', async () => {
    const rig = await createSpiRig({
      cr1: 0x7c,
      cr2: 0x0700,
      data: 0x5a,
      size: 1,
      guards: true,
    });

    try {
      rig.run(10_000_000);
      expect(rig.faults).toEqual([]);
      expect(rig.state('g0')).toBe(0x7c); // 0x40 写没有别名 CR1
      expect(rig.state('g1')).toBe(0); // 8 位帧 0x0d 高 byte 不是有效 DR lane
      expect(rig.state('g4')).toBe(6); // 仅读 SR/高 lane 不清 RXNE/OVR
      expect(rig.state('g2')).toBe(0x77); // 0x0c 读返回 RXDR
      expect(rig.state('g5')).toBe(0); // DR→SR 后 OVR/DR_READ 均清
      expect(rig.state('g6')).toBe(0); // 0x0e 高 halfword 不启动帧
      expect(rig.state('g7')).toBe(1); // 0x0c 有效 DR 启动帧
      expect(rig.state('g8')).toBe(0); // 0x40 私有/保留窗口读 0
    } finally {
      rig.dispose();
    }
  });

  it('分 50 次 100 µs 推进与一次 5 ms 推进等价（余数不丢失）', async () => {
    const once = await createSpiRig({
      cr1: 0x7c,
      cr2: 0x0700,
      data: 0x5a,
      size: 1,
      clockFrequency: 1_000,
      time: true,
    });
    const split = await createSpiRig({
      cr1: 0x7c,
      cr2: 0x0700,
      data: 0x5a,
      size: 1,
      clockFrequency: 1_000,
      timeSplit: true,
    });

    try {
      once.run(1_000_000_000);
      for (let step = 0; step < 4_000; step += 1) split.run(1_000_000);
      expect(split.result()).toBe(once.result());
      expect(split.state('fraction')).toBe(0);
    } finally {
      once.dispose();
      split.dispose();
    }
  });

  it('SPI1 半周期取自 RCC 缓存（8 MHz、BR=111 -> 16 µs）', async () => {
    const rig = await createSpiRig({
      cr1: 0x7c,
      cr2: 0x0700,
      data: 0x5a,
      size: 1,
      clock: true,
      clockHz: 8_000_000,
    });

    try {
      rig.run(10_000_000);
      expect(rig.result()).toBe(16_000_000);
    } finally {
      rig.dispose();
    }
  });
});
