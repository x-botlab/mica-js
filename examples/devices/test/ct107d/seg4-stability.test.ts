import { describe, expect, it } from 'vitest';
import { createTestBoard, US } from './harness.ts';
import type { TestBoard } from './harness.ts';

/**
 * `seg4` 的稳定窗口回归：段码必须连续稳定 `settleUs` 才提交，窗口内发生消隐、
 * 换码或短暂回到旧码都会让候选失效。取消选中只保持显示，稳定选中的 0 段码允许熄灭。
 *
 * 电路与 `examples/devices/test/seg4/harness.ts` 同构：12 根引脚各接一个数字源，源用 25 Ω
 * 拉高/拉低，板级电气、DDL 采样与通道都走真实仿真。
 */

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;
const COMMONS = ['com1', 'com2', 'com3', 'com4'] as const;
const PINS = [...SEGMENTS, ...COMMONS] as const;

const A = 0x06; // b、c
const B = 0x5b; // a、b、d、e、g

async function circuit(props: Readonly<Record<string, unknown>> = {}): Promise<TestBoard> {
  return createTestBoard('seg4', {
    props,
    sources: PINS.map((pin) => `src_${pin}`),
    nets: [
      {
        id: 'vcc',
        voltage: 5,
        pins: PINS.map((pin) => ({ instance: `src_${pin}`, pin: 'vcc' })),
      },
      {
        id: 'gnd',
        voltage: 0,
        pins: PINS.map((pin) => ({ instance: `src_${pin}`, pin: 'gnd' })),
      },
      ...PINS.map((pin) => ({
        id: pin,
        pins: [
          { instance: 'dut', pin },
          { instance: `src_${pin}`, pin: 'y' },
        ],
      })),
    ],
  });
}

/** 共阴驱动：段高点亮、位低选中。 */
function show(built: TestBoard, mask: number, active: readonly number[]): void {
  for (const [index, pin] of SEGMENTS.entries()) {
    built.send(`src_${pin}`, 'level', ((mask >> index) & 1) === 1 ? 1 : 0);
  }
  for (let digit = 0; digit < COMMONS.length; digit += 1) {
    built.send(`src_${COMMONS[digit]}`, 'level', active.includes(digit) ? 0 : 1);
  }
}

describe('seg4 稳定窗口', () => {
  it('窗口内换码时，等待结束后不会提交只稳定了不足 50 us 的新段码', async () => {
    const built = await circuit();

    try {
      // t=1 us：选中第 1 位，段码 A。过程在 t=0 触发后原本会在 t=50 us 醒来。
      show(built, A, [0]);
      built.run(US);
      expect(built.outputs.digit1).toBe(0);

      // t=11 us：窗口内先消隐，再换成 B；B 到 t=61 us 才连续稳定满 50 us。
      show(built, 0x00, [0]);
      built.run(10 * US);
      show(built, B, [0]);
      built.runUntil(55 * US);
      expect(built.outputs.digit1).toBe(0);

      built.runUntil(62 * US);
      expect(built.outputs.digit1).toBe(B);
    } finally {
      built.dispose();
    }
  });

  it('窗口内短暂回到旧段码也算不连续，必须重新等待满 50 us', async () => {
    const built = await circuit();

    try {
      show(built, A, [0]);
      built.run(US);

      // t=11 us：消隐后恢复到 A。虽然当前值与 t=0 的候选相同，但 A 并未连续稳定。
      show(built, 0x00, [0]);
      built.run(10 * US);
      show(built, A, [0]);
      built.runUntil(55 * US);
      expect(built.outputs.digit1).toBe(0);

      built.runUntil(62 * US);
      expect(built.outputs.digit1).toBe(A);
    } finally {
      built.dispose();
    }
  });

  it('连续稳定 50 us 的 0 段码允许该位熄灭', async () => {
    const built = await circuit();

    try {
      show(built, A, [0]);
      built.run(1_000 * US);
      expect(built.outputs.digit1).toBe(A);

      const blankAt = built.time;
      show(built, 0x00, [0]);
      built.runUntil(blankAt + 49 * US);
      expect(built.outputs.digit1).toBe(A);

      built.runUntil(blankAt + 51 * US);
      expect(built.outputs.digit1).toBe(0);
    } finally {
      built.dispose();
    }
  });

  it('取消选中只保持；重新选中后仍要新的连续稳定窗口', async () => {
    const built = await circuit();

    try {
      show(built, B, [0]);
      built.run(1_000 * US);
      expect(built.outputs.digit1).toBe(B);

      // 取消选中，段总线换成 A：显示保持 B。
      show(built, A, []);
      built.run(1_000 * US);
      expect(built.outputs.digit1).toBe(B);

      const selectedAt = built.time;
      show(built, A, [0]);
      built.runUntil(selectedAt + 49 * US);
      expect(built.outputs.digit1).toBe(B);

      built.runUntil(selectedAt + 51 * US);
      expect(built.outputs.digit1).toBe(A);
    } finally {
      built.dispose();
    }
  });
});
