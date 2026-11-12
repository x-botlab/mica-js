import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * LM386 的行为基线：INP 高 / INN 低时 OUT 推挽到 VCC、INP 与 INN 同电平时抑制输出，
 * `active` 端口，以及只有 DUT 自身使用的 GAIN/BYPASS 被动引脚。
 *
 * INP/INN 由数字源驱动，OUT 用探针在网络采样。
 */

interface Fixture {
  readonly board: TestBoard;
  drive(pin: 'inp' | 'inn', level: number): void;
}

async function fixture(props: Record<string, unknown> = {}): Promise<Fixture> {
  const sources = ['inpSrc', 'innSrc'];
  const nets: NetDescription[] = [
    { id: 'vcc', pins: [{ instance: 'dut', pin: 'vcc' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
  ];

  for (const pin of ['inp', 'inn'] as const) {
    nets.push({
      id: pin,
      pins: [
        { instance: 'dut', pin },
        { instance: `${pin}Src`, pin: 'y' },
      ],
    });
  }

  nets.push({
    id: 'out',
    pins: [
      { instance: 'dut', pin: 'out' },
      { instance: 'outProbe', pin: 'y' },
    ],
  });

  for (const id of sources) {
    nets.push(
      { id: `${id}-vcc`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}-gnd`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );
  }

  const board = await createTestBoard('lm386', { nets, probes: ['outProbe'], sources, props });

  return {
    board,
    drive(pin, level) {
      board.send(`${pin}Src`, 'level', level);
    },
  };
}

describe('LM386', () => {
  it('元数据声明 8 根引脚、gain 属性与 active 端口', () => {
    const metadata = readMetadata('lm386') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, { readonly default: unknown }>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(8);
    expect(metadata.properties.gain?.default).toBe(20);
    expect(metadata.ports.active?.type).toBe('boolean');
  });

  it('INN 接地时 OUT 跟随 INP', async () => {
    const built = await fixture();

    try {
      built.drive('inn', 0);

      built.drive('inp', 1);
      built.board.run(US);
      expect(built.board.probe('outProbe')).toBe(1);
      expect(built.board.topics.active).toBe(true);

      built.drive('inp', 0);
      built.board.run(US);
      expect(built.board.probe('outProbe')).toBe(0);
      expect(built.board.topics.active).toBe(false);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('INP 与 INN 同电平时抑制输出（含 INN 拉高）', async () => {
    const built = await fixture();

    try {
      built.drive('inp', 1);
      built.drive('inn', 1);
      built.board.run(US);
      expect(built.board.probe('outProbe')).toBe(0);
      expect(built.board.topics.active).toBe(false);

      built.drive('inn', 0);
      built.board.run(US);
      expect(built.board.probe('outProbe')).toBe(1);

      built.drive('inp', 0);
      built.board.run(US);
      expect(built.board.probe('outProbe')).toBe(0);
      expect(built.board.topics.active).toBe(false);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('初始化先发布一次当前值：输入悬空时 OUT 为低', async () => {
    const built = await fixture();

    try {
      built.board.run(US);

      expect(built.board.probe('outProbe')).toBe(0);
      expect(built.board.topics.active).toBe(false);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('gain=200 只改元数据，输出行为与 gain=20 相同', async () => {
    const built = await fixture({ gain: 200 });

    try {
      built.drive('inn', 0);
      built.drive('inp', 1);
      built.board.run(US);

      expect(built.board.probe('outProbe')).toBe(1);
      expect(built.board.topics.active).toBe(true);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });
});
