import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 74HC02 的行为基线：四门真值表 Y = !(A || B)、未知输入按低处理，以及 14 根引脚的元数据。
 *
 * 输入由数字源驱动，输出电平用探针在 `y1`–`y4` 网络上采样，不读取器件内部值。
 */

const GATES = [1, 2, 3, 4] as const;
const COMBINATIONS = [
  { a: 0, b: 0, y: 1 },
  { a: 0, b: 1, y: 0 },
  { a: 1, b: 0, y: 0 },
  { a: 1, b: 1, y: 0 },
] as const;

interface Fixture {
  readonly board: TestBoard;
  drive(gate: number, a: number, b: number): void;
  y(gate: number): number;
}

async function fixture(): Promise<Fixture> {
  const nets: NetDescription[] = [
    { id: 'vcc', pins: [{ instance: 'dut', pin: 'vcc' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
  ];
  const sources = GATES.flatMap((gate) => [`a${gate}Src`, `b${gate}Src`]);
  const probes = GATES.map((gate) => `y${gate}Probe`);

  for (const gate of GATES) {
    nets.push(
      {
        id: `a${gate}`,
        pins: [
          { instance: 'dut', pin: `a${gate}` },
          { instance: `a${gate}Src`, pin: 'y' },
        ],
      },
      {
        id: `b${gate}`,
        pins: [
          { instance: 'dut', pin: `b${gate}` },
          { instance: `b${gate}Src`, pin: 'y' },
        ],
      },
      {
        id: `y${gate}`,
        pins: [
          { instance: 'dut', pin: `y${gate}` },
          { instance: `y${gate}Probe`, pin: 'y' },
        ],
      },
    );
  }

  for (const id of sources) {
    nets.push(
      { id: `${id}-vcc`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}-gnd`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );
  }

  const board = await createTestBoard('74hc02', { nets, probes, sources });

  return {
    board,
    drive(gate, a, b) {
      board.send(`a${gate}Src`, 'level', a);
      board.send(`b${gate}Src`, 'level', b);
    },
    y(gate) {
      return board.probe(`y${gate}Probe`);
    },
  };
}

describe('74HC02', () => {
  it('元数据声明 14 根引脚且没有端口', () => {
    const metadata = readMetadata('74hc02') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports?: Readonly<Record<string, unknown>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(14);
    expect(metadata.ports).toBeUndefined();
  });

  it('四门在全部输入组合下都满足 Y = !(A || B)', async () => {
    const built = await fixture();

    try {
      for (const combination of COMBINATIONS) {
        for (const gate of GATES) {
          built.drive(gate, combination.a, combination.b);
          built.board.run(US);
        }

        for (const gate of GATES) expect(built.y(gate)).toBe(combination.y);
        expect(built.board.faults).toEqual([]);
      }
    } finally {
      built.board.dispose();
    }
  });

  it('释放的输入按低处理，输出不会停在未知电平', async () => {
    const built = await fixture();

    try {
      for (const gate of GATES) built.drive(gate, 2, 2);
      built.board.run(US);

      for (const gate of GATES) expect(built.y(gate)).toBe(1);

      // 一端确定拉高时，另一端的未知仍然按低处理，或非输出为低。
      for (const gate of GATES) built.drive(gate, 2, 1);
      built.board.run(US);

      for (const gate of GATES) expect(built.y(gate)).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });
});
