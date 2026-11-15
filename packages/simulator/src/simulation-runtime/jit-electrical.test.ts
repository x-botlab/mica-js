import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { Board, JitTranslate } from '../types';

/**
 * 直接 JIT 的电气写入回归面。
 *
 * 每条块同时驱动两个引脚，并在同一块内 `elapse CYCLE_PS`。`wr` 和 `wide` 位于槽 31/32，
 * 反应捕获 `data`、`wr` 和另一路引脚的采样：
 * - 身份变化必须让块在指令边界失效，两个引脚的 intent 才能一次性发布；
 * - 正时长前失效必须保留 prefix 时刻，恢复时 suffix 只执行一次；
 * - reaction / process 通过 host 写入的 state bank 必须被下一块看见；
 * - 脏字必须逐个枚举，符号位和第二个字里的写入不能丢。
 */

const CYCLE_PS = 10;
const WARMUP_PS = 41;
const TARGET_PS = 81;
const EDGE_BYTES = 8;

const translation =
  (stable: boolean, tail = false): JitTranslate =>
  ({ pc }, block) => {
    block.instruction({ pc, nextPc: pc === 0 ? 1 : 0 }, (b) => {
      const one = b.constant(types.number, 1);
      // 槽 31 的符号位和槽 32 的下一脏字都必须正确写回。
      b.writeState('wr', b.constant(types.number, pc === 0 ? 1 : 0));
      b.writeState('data', b.add(b.readState('data', types.number), one));
      b.writeState('wide', b.readState('data', types.number));
      b.writeState('prefixes', b.add(b.readState('prefixes', types.number), one));
      b.writeState('seenProcess', b.readState('processValue', types.number));
      b.writeState('seenReaction', b.readState('reactionValue', types.number));
      const intent =
        stable || pc === 0
          ? b.combineIntents(b.resistor(b.pin('mid'), b.constant(types.number, 1000)))
          : b.combineIntents(b.resistor(b.pin('gnd'), b.constant(types.number, 1000)));
      // 同一条指令写两个引脚：失效只能发生在两个 intent 都落定之后。
      b.writeIntent('drive', intent);
      b.writeIntent('gate', intent);
      b.elapse(b.constant(types.number, CYCLE_PS));
      // 只有恢复路径会执行到这里；计数用来说明 suffix 恰好一次。
      if (!tail) b.writeState('suffixes', b.add(b.readState('suffixes', types.number), one));
    });
    return block.finish();
  };

function electricalModel() {
  const builder = createDeviceBuilder({ name: 'DirectElectrical' });
  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'evidence', length: 256, public: true });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'data', type: types.number, initial: 0 });
  builder.state({ name: 'prefixes', type: types.number, initial: 0 });
  builder.state({ name: 'suffixes', type: types.number, initial: 0 });
  builder.state({ name: 'cursor', type: types.number, initial: 0 });
  builder.state({ name: 'processValue', type: types.number, initial: 0 });
  builder.state({ name: 'reactionValue', type: types.number, initial: 0 });
  builder.state({ name: 'seenProcess', type: types.number, initial: 0 });
  builder.state({ name: 'seenReaction', type: types.number, initial: 0 });
  // direct bank 按声明排序：9 个状态 + 22 个填充使 wr/ wide 分别位于槽 31/32。
  for (let index = 0; index < 22; index += 1)
    builder.state({ name: `pad${index}`, type: types.number, initial: 0 });
  builder.state({ name: 'wr', type: types.number, initial: 0 });
  builder.state({ name: 'wide', type: types.number, initial: 0 });
  builder.pin({ name: 'mid' });
  builder.pin({ name: 'gnd' });
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  builder.pin({ name: 'gate', low: 0.8, high: 2.0 });
  builder.start((body) => {
    body.loop((loop) => {
      loop.wait(15);
      loop.writeState(
        'processValue',
        loop.add(loop.readState('processValue', types.number), loop.constant(types.number, 1)),
      );
    });
  });
  builder.reaction(
    {
      name: 'watchDrive',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'previousLevel',
      current: 'currentLevel',
      captures: [
        { name: 'savedData', type: types.number },
        { name: 'savedWr', type: types.number },
        { name: 'gateHigh', type: types.bool },
      ],
    },
    {
      savedData: (body) => body.returnValue(body.readState('data', types.number)),
      savedWr: (body) => body.returnValue(body.readState('wr', types.number)),
      gateHigh: (body) =>
        body.returnValue(
          body.equal(
            types.logic,
            body.field(body.readSample('gate'), 'level'),
            types.logic.members.high,
          ),
        ),
    },
    (body, bindings) => {
      const cursor = body.readState('cursor', types.number);
      const level = body.select(
        types.number,
        body.equal(types.logic, bindings.current, types.logic.members.high),
        (yes) => yes.constant(types.number, 1),
        (no) => no.constant(types.number, 0),
      );
      const gate = body.select(
        types.number,
        bindings.captures.gateHigh,
        (yes) => yes.constant(types.number, 1),
        (no) => no.constant(types.number, 0),
      );
      const at = (offset: number) => body.add(cursor, body.constant(types.number, offset));
      body.store8('evidence', at(0), level);
      body.store8('evidence', at(1), gate);
      body.store8('evidence', at(2), bindings.captures.savedData);
      body.store8('evidence', at(3), bindings.captures.savedWr);
      body.store32le('evidence', at(4), body.now());
      body.writeState('reactionValue', bindings.captures.savedData);
      body.writeState('cursor', at(EDGE_BYTES));
    },
  );
  return builder.finish();
}

interface Scenario {
  readonly board: Board;
  readonly instance: Instance;
  readonly jit: Jit;
  readonly evidence: Uint8Array;
}

function createScenario(
  execution: 'throughput' | 'precise',
  stable = false,
  tail = false,
): Scenario {
  let evidence: Uint8Array | undefined;
  const library = createDeviceLibrary([
    {
      id: 'dut',
      model: electricalModel(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'dut',
          code: 'code',
          pc: 'pc',
          translate: translation(stable, tail),
        });
        try {
          context.loadBytes('code', new Uint8Array(16));
          evidence = context.memory.evidence as Uint8Array;
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  const board = createBoard(
    library,
    {
      instances: [{ id: 'dut', type: 'dut' }],
      nets: [
        { id: 'mid', pins: [{ instance: 'dut', pin: 'mid' }], voltage: 2.5 },
        { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
      ],
    },
    { execution },
  );
  const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
  return { board, instance, jit: instance.jits[0] as Jit, evidence: evidence! };
}

/** 预热多轮，确保后续断言确实覆盖直接程序而不是解释器。 */
function warmDirect(scenario: Scenario): void {
  scenario.board.runUntil(WARMUP_PS);
  const stats = directJitStats(scenario.jit);
  expect(stats?.directCalls ?? 0).toBeGreaterThan(0);
  expect((stats?.directCalls ?? 0) - (stats?.directFallbacks ?? 0)).toBeGreaterThan(0);
}

interface EdgeRecord {
  readonly level: number;
  readonly gate: number;
  readonly data: number;
  readonly wr: number;
  readonly time: number;
}

function edgeRecords(scenario: Scenario): EdgeRecord[] {
  const cursor = scenario.instance.states.get('cursor') as number;
  // Public memory is a checked read-only view, not a raw Uint8Array; copy before parsing.
  const bytes = Uint8Array.from(scenario.evidence);
  const view = new DataView(bytes.buffer);
  return Array.from({ length: cursor / EDGE_BYTES }, (_, index) => {
    const offset = index * EDGE_BYTES;
    return {
      level: view.getUint8(offset),
      gate: view.getUint8(offset + 1),
      data: view.getUint8(offset + 2),
      wr: view.getUint8(offset + 3),
      time: view.getUint32(offset + 4, true),
    };
  });
}

describe('direct JIT electrical publication', () => {
  it('keeps identical intents inside a direct run without extra publication', () => {
    const scenario = createScenario('throughput', true);
    try {
      warmDirect(scenario);
      const calls = directJitStats(scenario.jit)!.directCalls;
      scenario.board.runUntil(TARGET_PS);
      expect(edgeRecords(scenario)).toHaveLength(1);
      // A pending suffix returns once; subsequent unchanged intents run to each event.
      expect(directJitStats(scenario.jit)!.directCalls - calls).toBeLessThan(8);
      expect(scenario.instance.states.get('prefixes')).toBe(9);
    } finally {
      scenario.board.dispose();
    }
  });

  it('publishes repeated multi-pin writes atomically and resumes each suffix once', () => {
    const scenario = createScenario('throughput');
    try {
      warmDirect(scenario);
      scenario.board.runUntil(TARGET_PS);

      const prefixes = scenario.instance.states.get('prefixes') as number;
      const suffixes = scenario.instance.states.get('suffixes') as number;
      expect(prefixes).toBeGreaterThanOrEqual(8);
      // 最后一条块正停在 due 之前，所以 suffix 恰好比 prefix 少一次。
      expect(suffixes).toBe(prefixes - 1);
      expect(scenario.instance.states.get('wide')).toBe(prefixes);

      const records = edgeRecords(scenario);
      expect(records).toHaveLength(prefixes);
      for (const [index, edge] of records.entries()) {
        const high = index % 2 === 0 ? 1 : 0;
        expect(edge.level).toBe(high);
        // 两个引脚在同一条指令里落定：观察 drive 时 gate 必须已经是同一电平。
        expect(edge.gate).toBe(high);
        // `wr` 占用第一个脏字的符号位，也必须完整写回。
        expect(edge.wr).toBe(high);
        // 捕获发生在 flush 之后，拿到的就是本块 prefix 写入的 data。
        expect(edge.data).toBe(index + 1);
        // 正时长前失效保留 prefix 时刻，而不是 due。
        expect(edge.time).toBe(index * CYCLE_PS);
      }
    } finally {
      scenario.board.dispose();
    }
  });

  it('completes a proven tail at due without a suffix resume', () => {
    const tail = createScenario('throughput', false, true);
    const regular = createScenario('throughput', false, false);
    try {
      warmDirect(tail);
      warmDirect(regular);
      const tailCalls = directJitStats(tail.jit)!.directCalls;
      const regularCalls = directJitStats(regular.jit)!.directCalls;
      tail.board.runUntil(TARGET_PS);
      regular.board.runUntil(TARGET_PS);

      const tailPrefixes = tail.instance.states.get('prefixes') as number;
      const regularPrefixes = regular.instance.states.get('prefixes') as number;
      expect(tailPrefixes).toBe(regularPrefixes);
      expect(tail.instance.states.get('suffixes')).toBe(0);
      expect(regular.instance.states.get('suffixes')).toBe(regularPrefixes - 1);
      expect(edgeRecords(tail)).toEqual(edgeRecords(regular));
      // The empty suffix no longer needs a resumed generated invocation.
      expect(directJitStats(tail.jit)!.directCalls - tailCalls).toBeLessThan(
        directJitStats(regular.jit)!.directCalls - regularCalls,
      );
    } finally {
      tail.board.dispose();
      regular.board.dispose();
    }
  });

  it('keeps the precise execution edge timeline', () => {
    const direct = createScenario('throughput');
    const precise = createScenario('precise');
    try {
      warmDirect(direct);
      direct.board.runUntil(TARGET_PS);
      precise.board.runUntil(TARGET_PS);

      expect(Array.from(direct.evidence)).toEqual(Array.from(precise.evidence));
    } finally {
      direct.board.dispose();
      precise.board.dispose();
    }
  });

  it('exposes reaction and process bank writes to the next direct block', () => {
    const scenario = createScenario('throughput');
    try {
      warmDirect(scenario);
      scenario.board.runUntil(TARGET_PS);

      const state = (name: string): number => scenario.instance.states.get(name) as number;
      const processValue = state('processValue');
      const reactionValue = state('reactionValue');
      expect(processValue).toBeGreaterThan(0);
      // t=80 的块读取上一轮 process / reaction 写入；普通 process 与 reaction 都必须在下一块可见。
      expect(state('seenProcess')).toBe(processValue);
      expect(reactionValue).toBeGreaterThan(0);
      // 本轮 reaction 在块 prefix 之后才运行，所以下一块看到的是上一轮的值。
      expect(state('seenReaction')).toBe(reactionValue - 1);
    } finally {
      scenario.board.dispose();
    }
  });
});
