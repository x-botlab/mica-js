import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, runRuntimeOnce, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 74HC138 的行为基线：8 种选择组合、三条禁用路径、低有效输出，以及 `select` /
 * `enabled` / `code` 三个端口。
 *
 * 六个输入由数字源驱动，八路输出用探针在 `y0`–`y7` 网络上采样。
 */

const OUTPUTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const INPUTS = ['a', 'b', 'c', 'e1', 'e2', 'e3'] as const;

interface Fixture {
  readonly board: TestBoard;
  drive(pin: (typeof INPUTS)[number], level: number): void;
  select(index: number): void;
  enable(e1: number, e2: number, e3: number): void;
  outputs(): number[];
}

function text(value: unknown): string {
  return Array.from(value as Iterable<number>, (byte) => String.fromCharCode(byte)).join('');
}

async function fixture(): Promise<Fixture> {
  const nets: NetDescription[] = [
    { id: 'vcc', pins: [{ instance: 'dut', pin: 'vcc' }], voltage: 5 },
    { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
  ];
  const sources = INPUTS.map((pin) => `${pin}Src`);
  const probes = OUTPUTS.map((index) => `y${index}Probe`);

  for (const pin of INPUTS) {
    nets.push({
      id: pin,
      pins: [
        { instance: 'dut', pin },
        { instance: `${pin}Src`, pin: 'y' },
      ],
    });
  }

  for (const index of OUTPUTS) {
    nets.push({
      id: `y${index}`,
      pins: [
        { instance: 'dut', pin: `y${index}` },
        { instance: `y${index}Probe`, pin: 'y' },
      ],
    });
  }

  for (const id of sources) {
    nets.push(
      { id: `${id}-vcc`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}-gnd`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );
  }

  const board = await createTestBoard('74hc138', { nets, probes, sources });
  const drive: Fixture['drive'] = (pin, level) => board.send(`${pin}Src`, 'level', level);

  return {
    board,
    drive,
    select(index) {
      drive('a', index & 1);
      drive('b', (index >> 1) & 1);
      drive('c', (index >> 2) & 1);
    },
    enable(e1, e2, e3) {
      drive('e1', e1);
      drive('e2', e2);
      drive('e3', e3);
    },
    outputs() {
      return OUTPUTS.map((index) => board.probe(`y${index}Probe`));
    },
  };
}

describe('74HC138', () => {
  it('元数据声明 16 根引脚与 number/boolean/bytes 三个端口', () => {
    const metadata = readMetadata('74hc138') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(16);
    expect(metadata.ports.select?.type).toBe('number');
    expect(metadata.ports.enabled?.type).toBe('boolean');
    expect(metadata.ports.code?.type).toBe('bytes');
  });

  it('使能时恰好一路拉低，序号由 A/B/C 选择', async () => {
    const built = await fixture();

    try {
      built.enable(0, 0, 1);

      for (const index of OUTPUTS) {
        built.select(index);
        built.board.run(US);

        const levels = built.outputs();
        for (const output of OUTPUTS) expect(levels[output]).toBe(output === index ? 0 : 1);

        expect(built.board.topics.select).toBe(index);
        expect(built.board.topics.enabled).toBe(true);
        expect(text(built.board.topics.code)).toBe(`Y${index}`);
        expect(built.board.faults).toEqual([]);
      }
    } finally {
      built.board.dispose();
    }
  });

  it('E1#=1、E2#=1、E3=0 三条禁用路径都把八路输出拉高', async () => {
    const built = await fixture();

    try {
      built.select(5);
      built.enable(0, 0, 1);
      built.board.run(US);
      expect(built.outputs()[5]).toBe(0);

      for (const [e1, e2, e3] of [
        [1, 0, 1],
        [0, 1, 1],
        [0, 0, 0],
      ] as const) {
        built.enable(e1, e2, e3);
        built.board.run(US);

        for (const level of built.outputs()) expect(level).toBe(1);
        expect(built.board.topics.select).toBe(-1);
        expect(built.board.topics.enabled).toBe(false);
        expect(text(built.board.topics.code)).toBe('--');
        expect(built.board.faults).toEqual([]);
      }

      built.enable(0, 0, 1);
      built.board.run(US);
      expect(built.outputs()[5]).toBe(0);
      expect(built.board.topics.select).toBe(5);
    } finally {
      built.board.dispose();
    }
  });

  it('初始化先发布一次当前值：所有输入悬空时为禁用', async () => {
    const built = await fixture();

    try {
      built.board.run(US);

      for (const level of built.outputs()) expect(level).toBe(1);
      expect(built.board.topics.select).toBe(-1);
      expect(built.board.topics.enabled).toBe(false);
      expect(text(built.board.topics.code)).toBe('--');
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('释放的使能输入按低处理：E3 悬空视为禁用', async () => {
    const built = await fixture();

    try {
      built.select(3);
      built.enable(0, 0, 2);
      built.board.run(US);

      for (const level of built.outputs()) expect(level).toBe(1);
      expect(built.board.topics.select).toBe(-1);
      expect(built.board.topics.enabled).toBe(false);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('code 端口发布真实 Uint8Array，运行时不再产生 device/output-failed', async () => {
    const built = await fixture();

    try {
      built.enable(0, 0, 1);
      built.select(6);
      built.board.run(US);

      expect(built.board.topics.code).toBeInstanceOf(Uint8Array);
      expect(text(built.board.topics.code)).toBe('Y6');

      // 走真实 simulation-runtime：只读代理会被 payloadMatches 拒绝并记入诊断。
      const runtime = await runRuntimeOnce('74hc138');

      expect(runtime.publishes.code).toBeInstanceOf(Uint8Array);
      expect(text(runtime.publishes.code)).toBe('--');
      expect(runtime.diagnostics.filter((entry) => entry.code === 'device/output-failed')).toEqual(
        [],
      );
    } finally {
      built.board.dispose();
    }
  });
});
