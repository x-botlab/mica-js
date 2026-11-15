import {
  createDeviceBuilder,
  types,
  type Constant,
  type DeviceBuilder,
  type DeviceIR,
  type MemoryInput,
  type Operand,
  type RuntimeValue,
  type Type,
  type Value,
} from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { Board, JitTranslate } from '../types';

/**
 * 同步发布续体的独立时序回归。
 *
 * 这里只使用 Builder 模型与真实运行时，不依赖 ILI9325 夹具或固件。覆盖最容易在
 * “发布回调/常驻执行”改动中破掉的合同：
 * - 正时长指令的 prefix 在开始时刻发布，suffix 在 due 只完成一次；
 * - due == runUntil(T) 时只记录到期，重复 runUntil(T) 不恢复 suffix；
 * - due 前、due 同刻的普通 process 都先于该指令的 suffix；
 * - 同指令多 pin 在同一原子边界发布；
 * - 代码在 parked 指令期间失效时，旧指令 suffix 仍按旧翻译完成一次；
 * - 全轮 capture-before-body、capture 失败不执行 body、body 失败保留成功前缀。
 *
 * 每个 throughput 用例都断言 `directCalls - directFallbacks > 0`，避免测试实际上只走
 * 解释器回退。观察源只放在 pin sample 与 reaction 自己的日志上，不通过观察 MCU state
 * 迫使所有块 fallback。
 */

const TRACE_BYTES = 8;
const CYCLE_PS = 10;
const TRACE_TAG = {
  prefix: 1,
  suffix: 2,
  nextPrefix: 3,
  processBeforeDue: 10,
  processAtDue: 11,
  reaction: 20,
  captureA: 30,
  captureB: 31,
  captureC: 32,
  codeInvalidation: 40,
  boundaryGood: 50,
  boundaryAfter: 51,
  kickProcess: 60,
  kickLater: 61,
  nextPc: 70,
  staleNext: 71,
  freshNext: 72,
} as const;

interface TraceBody {
  readState<T extends RuntimeValue>(name: string, type: Type<T>): Value<T>;
  writeState<T extends RuntimeValue>(name: string, value: Operand<T>): void;
  add(left: Operand<number>, right: Operand<number>): Value<number>;
  constant<T extends RuntimeValue>(type: Type<T>, value: NoInfer<Constant<T>>): Value<T>;
  store8(memory: MemoryInput, offset: Operand<number>, value: Operand<number>): void;
  store32le(memory: MemoryInput, offset: Operand<number>, value: Operand<number>): void;
  now(): Value<number>;
}

const numberOperand = (body: TraceBody, value: number | Operand<number>): Operand<number> =>
  typeof value === 'number' ? body.constant(types.number, value) : value;

/** 8-byte record: tag, a, b, reserved, now u32le. */
function trace(
  body: TraceBody,
  tag: number,
  a: number | Operand<number> = 0,
  b: number | Operand<number> = 0,
): void {
  const cursor = body.readState('cursor', types.number);
  const at = (offset: number): Value<number> =>
    body.add(cursor, body.constant(types.number, offset));

  body.store8('trace', at(0), body.constant(types.number, tag));
  body.store8('trace', at(1), numberOperand(body, a));
  body.store8('trace', at(2), numberOperand(body, b));
  body.store8('trace', at(3), body.constant(types.number, 0));
  body.store32le('trace', at(4), body.now());
  body.writeState('cursor', body.add(cursor, body.constant(types.number, TRACE_BYTES)));
}

function traceModel(name: string): DeviceBuilder {
  const builder = createDeviceBuilder({ name });

  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'trace', length: 1024, public: true });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'cursor', type: types.number, initial: 0 });
  builder.pin({ name: 'mid' });
  builder.pin({ name: 'gnd' });
  return builder;
}

interface Scenario {
  readonly board: Board;
  readonly instance: Instance;
  readonly jit: Jit;
  readonly trace: Uint8Array;
}

function createScenario(
  model: DeviceIR,
  translate: JitTranslate,
  execution: 'throughput' | 'precise' = 'throughput',
): Scenario {
  let traceBytes: Uint8Array | undefined;
  const library = createDeviceLibrary([
    {
      id: 'dut',
      model,
      create: (context) => {
        const registration = context.attachJit({
          entry: 'dut',
          code: 'code',
          pc: 'pc',
          translate,
        });
        try {
          context.loadBytes('code', new Uint8Array(16));
          traceBytes = context.memory.trace as Uint8Array;
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
  return { board, instance, jit: instance.jits[0] as Jit, trace: traceBytes! };
}

interface TraceRecord {
  readonly tag: number;
  readonly a: number;
  readonly b: number;
  readonly time: number;
}

function records(scenario: Scenario): TraceRecord[] {
  const cursor = scenario.instance.states.get('cursor') as number;

  if (cursor % TRACE_BYTES !== 0) throw new Error(`unaligned trace cursor ${cursor}`);
  const bytes = Uint8Array.from(scenario.trace);
  const view = new DataView(bytes.buffer);

  return Array.from({ length: cursor / TRACE_BYTES }, (_, index) => {
    const at = index * TRACE_BYTES;
    return {
      tag: view.getUint8(at),
      a: view.getUint8(at + 1),
      b: view.getUint8(at + 2),
      time: view.getUint32(at + 4, true),
    };
  });
}

function expectDirect(scenario: Scenario): void {
  const stats = directJitStats(scenario.jit);

  expect(stats).toBeDefined();
  expect(stats!.directCalls - stats!.directFallbacks).toBeGreaterThan(0);
}

interface PublishSpy {
  readonly phases: string[];
  restore(): void;
}

/** 在 prefix 动作发生前包住当前 direct frame 的 publish hook，证明测试走的是同步回调。 */
function spyPublish(scenario: Scenario): PublishSpy {
  const frame = scenario.jit.direct?.frame as
    | {
        host?: {
          publish: ((phase: string) => boolean) | undefined;
        };
      }
    | undefined;
  const host = frame?.host;
  const original = host?.publish;

  expect(host).toBeDefined();
  expect(original).toBeTypeOf('function');
  const phases: string[] = [];

  host!.publish = (phase) => {
    phases.push(phase);
    return original!.call(host, phase);
  };
  return {
    phases,
    restore: () => {
      host!.publish = original;
    },
  };
}

function timingModel(): DeviceIR {
  const builder = traceModel('SynchronousTiming');

  builder.state({ name: 'prefixes', type: types.number, initial: 0 });
  builder.state({ name: 'suffixes', type: types.number, initial: 0 });
  builder.state({ name: 'armed', type: types.number, initial: 0 });
  builder.state({ name: 'pending', type: types.number, initial: 0 });
  builder.state({ name: 'warmup', type: types.number, initial: 0 });
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  builder.pin({ name: 'gate', low: 0.8, high: 2.0 });
  builder.start((body) => {
    body.loop((loop) => {
      loop.wait(5);
      loop.writeState('armed', loop.constant(types.number, 1));
      loop.wait(9);
      trace(loop, TRACE_TAG.processBeforeDue);
      loop.wait(1);
      trace(loop, TRACE_TAG.processAtDue);
      loop.wait(100);
    });
  });
  builder.reaction(
    {
      name: 'watchDrive',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'previousLevel',
      current: 'currentLevel',
      captures: [{ name: 'gateHigh', type: types.bool }],
    },
    {
      gateHigh: (capture) =>
        capture.returnValue(
          capture.equal(
            types.logic,
            capture.field(capture.readSample('gate'), 'level'),
            types.logic.members.high,
          ),
        ),
    },
    (body, bindings) => {
      const gate = body.select(
        types.number,
        bindings.captures.gateHigh,
        (yes) => yes.constant(types.number, 1),
        (no) => no.constant(types.number, 0),
      );
      trace(body, TRACE_TAG.reaction, gate);
    },
  );
  return builder.finish();
}

const timingTranslate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: 0 }, (body) => {
    const zero = body.constant(types.number, 0);
    const one = body.constant(types.number, 1);
    const armed = body.readState('armed', types.number);

    // 先跑几轮短块，让 Direct 程序在翻译完成后真正接替解释器；否则单条 parked
    // 指令会一直停在解释器里，测试就无法证明运行时走了 Direct。
    body.if(body.equal(types.number, armed, zero), (warm) => {
      warm.writeState(
        'warmup',
        warm.add(warm.readState('warmup', types.number), warm.constant(types.number, 1)),
      );
    });
    body.if(body.equal(types.number, armed, one), (prefix) => {
      prefix.writeState(
        'prefixes',
        prefix.add(prefix.readState('prefixes', types.number), prefix.constant(types.number, 1)),
      );
      prefix.writeState('pending', prefix.constant(types.number, 1));
      trace(prefix, TRACE_TAG.prefix);
      const high = prefix.combineIntents(
        prefix.resistor(prefix.pin('mid'), prefix.constant(types.number, 1000)),
      );
      prefix.writeIntent('drive', high);
      prefix.writeIntent('gate', high);
    });
    body.if(body.equal(types.number, armed, body.constant(types.number, 2)), (next) => {
      trace(next, TRACE_TAG.nextPrefix);
    });

    const duration = body.select(
      types.number,
      body.equal(types.number, armed, zero),
      (warm) => warm.constant(types.number, 1),
      (notWarm) =>
        notWarm.select(
          types.number,
          notWarm.equal(types.number, armed, one),
          (prefix) => prefix.constant(types.number, CYCLE_PS),
          (next) => next.constant(types.number, 100),
        ),
    );

    body.elapse(duration);

    body.if(body.equal(types.number, body.readState('pending', types.number), one), (suffix) => {
      suffix.writeState(
        'suffixes',
        suffix.add(suffix.readState('suffixes', types.number), suffix.constant(types.number, 1)),
      );
      suffix.writeState('pending', suffix.constant(types.number, 0));
      suffix.writeState('armed', suffix.constant(types.number, 2));
      trace(suffix, TRACE_TAG.suffix);
      const low = suffix.combineIntents(
        suffix.resistor(suffix.pin('gnd'), suffix.constant(types.number, 1000)),
      );
      suffix.writeIntent('drive', low);
      suffix.writeIntent('gate', low);
    });
  });
  return block.finish();
};

describe('synchronous JIT publication continuation', () => {
  it('publishes the prefix at t, holds a due suffix at T, and resumes it once after T', () => {
    const scenario = createScenario(timingModel(), timingTranslate);

    try {
      scenario.board.runUntil(0);
      expect(records(scenario)).toEqual([]);
      // 0..5 是 Direct 预热；t=5 的普通 process 把 armed 置 1，随后发布 prefix。
      scenario.board.runUntil(5);
      scenario.board.runUntil(15);
      expect(scenario.board.time).toBe(15);

      const atDue = records(scenario);

      // Prefix 在 t=5 发布；14/15 的普通 process 先于 due 的 suffix。
      expect(atDue).toEqual([
        { tag: TRACE_TAG.prefix, a: 0, b: 0, time: 5 },
        { tag: TRACE_TAG.reaction, a: 1, b: 0, time: 5 },
        { tag: TRACE_TAG.processBeforeDue, a: 0, b: 0, time: 14 },
        { tag: TRACE_TAG.processAtDue, a: 0, b: 0, time: 15 },
      ]);

      // due == T：只记录到期，不恢复 suffix；重复同一个目标也不恢复。
      scenario.board.runUntil(15);
      expect(records(scenario)).toEqual(atDue);

      scenario.board.runUntil(16);
      expect(records(scenario)).toEqual([
        ...atDue,
        { tag: TRACE_TAG.suffix, a: 0, b: 0, time: 15 },
        // 同指令两个 pin 低电平在同一原子边界发布。
        { tag: TRACE_TAG.reaction, a: 0, b: 0, time: 15 },
        // 尾空/下一块在 due 之后开始一次。
        { tag: TRACE_TAG.nextPrefix, a: 0, b: 0, time: 15 },
      ]);
      expect(scenario.instance.states.get('prefixes')).toBe(1);
      expect(scenario.instance.states.get('suffixes')).toBe(1);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('keeps the same trace in precise and throughput execution', () => {
    const direct = createScenario(timingModel(), timingTranslate);
    const precise = createScenario(timingModel(), timingTranslate, 'precise');

    try {
      for (const scenario of [direct, precise]) {
        scenario.board.runUntil(0);
        scenario.board.runUntil(5);
        scenario.board.runUntil(15);
        scenario.board.runUntil(15);
        scenario.board.runUntil(16);
      }
      expect(records(precise)).toEqual(records(direct));
      expect(precise.instance.states.get('prefixes')).toBe(direct.instance.states.get('prefixes'));
      expect(precise.instance.states.get('suffixes')).toBe(direct.instance.states.get('suffixes'));
    } finally {
      direct.board.dispose();
      precise.board.dispose();
    }
  });

  it('finishes the old instruction once when code changes while the instruction is parked', () => {
    const builder = traceModel('CodeInvalidation');

    builder.state({ name: 'prefixes', type: types.number, initial: 0 });
    builder.state({ name: 'suffixes', type: types.number, initial: 0 });
    builder.state({ name: 'armed', type: types.number, initial: 0 });
    builder.state({ name: 'pending', type: types.number, initial: 0 });
    builder.state({ name: 'warmup', type: types.number, initial: 0 });
    builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
    builder.start((body) => {
      body.loop((loop) => {
        loop.wait(4);
        loop.writeState('armed', loop.constant(types.number, 1));
        loop.wait(5);
        trace(loop, TRACE_TAG.codeInvalidation);
        loop.store8('code', loop.constant(types.number, 0), loop.constant(types.number, 1));
        loop.wait(100);
      });
    });

    const translate: JitTranslate = ({ pc, code }, block) => {
      const version = code[0] ?? 0;

      block.instruction({ pc, nextPc: 0 }, (body) => {
        const zero = body.constant(types.number, 0);
        const one = body.constant(types.number, 1);
        const two = body.constant(types.number, 2);
        const armed = body.readState('armed', types.number);

        body.if(body.equal(types.number, armed, zero), (warm) => {
          warm.writeState(
            'warmup',
            warm.add(warm.readState('warmup', types.number), warm.constant(types.number, 1)),
          );
        });
        const prefixArmed = version === 0 ? one : two;
        body.if(body.equal(types.number, armed, prefixArmed), (prefix) => {
          prefix.writeState(
            'prefixes',
            prefix.add(
              prefix.readState('prefixes', types.number),
              prefix.constant(types.number, 1),
            ),
          );
          prefix.writeState('pending', prefix.constant(types.number, 1));
          trace(prefix, version === 0 ? TRACE_TAG.prefix : TRACE_TAG.nextPrefix);
          const high = prefix.combineIntents(
            prefix.resistor(prefix.pin('mid'), prefix.constant(types.number, 1000)),
          );
          prefix.writeIntent('drive', high);
        });

        const duration = body.select(
          types.number,
          body.equal(types.number, armed, zero),
          (warm) => warm.constant(types.number, 1),
          (notWarm) =>
            notWarm.select(
              types.number,
              notWarm.equal(types.number, armed, prefixArmed),
              (prefix) => prefix.constant(types.number, CYCLE_PS),
              (next) => next.constant(types.number, 100),
            ),
        );

        body.elapse(duration);

        body.if(
          body.equal(types.number, body.readState('pending', types.number), one),
          (suffix) => {
            suffix.writeState(
              'suffixes',
              suffix.add(
                suffix.readState('suffixes', types.number),
                suffix.constant(types.number, 1),
              ),
            );
            suffix.writeState('pending', suffix.constant(types.number, 0));
            suffix.writeState('armed', suffix.constant(types.number, version === 0 ? 2 : 3));
            trace(suffix, version === 0 ? TRACE_TAG.suffix : 4);
            const low = suffix.combineIntents(
              suffix.resistor(suffix.pin('gnd'), suffix.constant(types.number, 1000)),
            );
            suffix.writeIntent('drive', low);
          },
        );
      });
      return block.finish();
    };
    const scenario = createScenario(builder.finish(), translate);

    try {
      scenario.board.runUntil(0);
      // 0..4 预热 Direct；t=4 普通 process 置 armed=1，随后开始旧指令。
      scenario.board.runUntil(4);
      scenario.board.runUntil(9);
      expect(records(scenario)).toEqual([
        { tag: TRACE_TAG.prefix, a: 0, b: 0, time: 4 },
        { tag: TRACE_TAG.codeInvalidation, a: 0, b: 0, time: 9 },
      ]);

      // 代码已在 parked 期间失效。T=14 仍不恢复旧 suffix。
      scenario.board.runUntil(14);
      const atDue = records(scenario);

      expect(atDue.map((record) => record.tag)).toEqual([
        TRACE_TAG.prefix,
        TRACE_TAG.codeInvalidation,
      ]);
      scenario.board.runUntil(14);
      expect(records(scenario)).toEqual(atDue);

      scenario.board.runUntil(15);
      expect(records(scenario)).toEqual([
        ...atDue,
        // 旧指令按旧翻译完成一次。
        { tag: TRACE_TAG.suffix, a: 0, b: 0, time: 14 },
        // 后续指令使用新代码，且只开始一次。
        { tag: TRACE_TAG.nextPrefix, a: 0, b: 0, time: 14 },
      ]);
      expect(scenario.instance.states.get('prefixes')).toBe(2);
      expect(scenario.instance.states.get('suffixes')).toBe(1);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('captures every reaction before any reaction body runs', () => {
    const scenario = createScenario(reactionModel('capture-before'), reactionTranslate);

    try {
      scenario.board.runUntil(0);
      scenario.board.runUntil(5);
      expect(scenario.board.status).toBe('ready');
      expect(records(scenario)).toEqual([
        { tag: TRACE_TAG.prefix, a: 0, b: 0, time: 4 },
        // A 的 body 把 x 改为 99；B 的 capture 仍在任何 body 之前冻结为 0。
        { tag: TRACE_TAG.captureA, a: 0, b: 0, time: 4 },
        { tag: TRACE_TAG.captureB, a: 0, b: 0, time: 4 },
      ]);
      expect(scenario.instance.states.get('x')).toBe(99);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('executes no reaction body when a capture fails', () => {
    const scenario = createScenario(reactionModel('capture-fail'), reactionTranslate);

    try {
      scenario.board.runUntil(0);
      expect(() => scenario.board.runUntil(5)).toThrow(/capture failed/);
      expect(scenario.board.status).toBe('faulted');
      expect(records(scenario).map((record) => record.tag)).toEqual([TRACE_TAG.prefix]);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('keeps the successful body prefix and stops later bodies when a body fails', () => {
    const scenario = createScenario(reactionModel('body-fail'), reactionTranslate);

    try {
      scenario.board.runUntil(0);
      expect(() => scenario.board.runUntil(5)).toThrow(/body failed/);
      expect(scenario.board.status).toBe('faulted');
      expect(records(scenario).map((record) => record.tag)).toEqual([
        TRACE_TAG.prefix,
        TRACE_TAG.captureA,
        TRACE_TAG.captureB,
      ]);
      // A 的成功写入保留；B 失败后 C 不执行。
      expect(scenario.instance.states.get('x')).toBe(99);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('refuses inline prefix when a boundary reaction queues earlier model work', () => {
    const scenario = createScenario(horizonModel(), horizonTranslate);

    try {
      scenario.board.runUntil(0);
      scenario.board.runUntil(4);
      expectDirect(scenario);
      const spy = spyPublish(scenario);

      try {
        scenario.board.runUntil(30);
        expect(spy.phases).toContain('prefix');
      } finally {
        spy.restore();
      }

      expect(records(scenario)).toEqual([
        { tag: TRACE_TAG.prefix, a: 0, b: 0, time: 5 },
        { tag: TRACE_TAG.reaction, a: 0, b: 0, time: 5 },
        // reaction 在 prefix 边界写入 kick，普通过程在 prefix 同刻入队并安排 6 ps 事件。
        { tag: TRACE_TAG.kickProcess, a: 0, b: 0, time: 5 },
        { tag: TRACE_TAG.kickLater, a: 0, b: 0, time: 6 },
        // 旧 elapsed 在 due 完成；回调不能把下一块提前到 5/6。
        { tag: TRACE_TAG.nextPrefix, a: 0, b: 0, time: 15 },
      ]);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('uses the PC changed by a prefix reaction after completing the old elapsed stage', () => {
    const scenario = createScenario(pcChangeModel(), pcChangeTranslate);

    try {
      scenario.board.runUntil(0);
      scenario.board.runUntil(3);
      expectDirect(scenario);
      // 预热已让 pc=1 在 direct program 内；prefix reaction 改 PC 后应直接进入该块。
      expect([...(scenario.jit.direct?.pcs ?? [])]).toEqual(expect.arrayContaining([0, 1]));
      const spy = spyPublish(scenario);

      try {
        scenario.board.runUntil(30);
        expect(spy.phases).toContain('prefix');
      } finally {
        spy.restore();
      }

      expect(records(scenario)).toEqual([
        { tag: TRACE_TAG.prefix, a: 0, b: 0, time: 4 },
        { tag: TRACE_TAG.reaction, a: 0, b: 0, time: 4 },
        // prefix 阶段把 pc 改为 1；旧 elapsed 到 14 完成后才进入 pc=1。
        { tag: TRACE_TAG.nextPc, a: 0, b: 0, time: 14 },
      ]);
      // 旧 nextPc=0 的陈旧块没有在 15 执行。
      expect(records(scenario).some((record) => record.tag === TRACE_TAG.staleNext)).toBe(false);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('does not execute a stale next block when code changes without a parked suffix', () => {
    const scenario = createScenario(
      instructionInvalidationModel(),
      instructionInvalidationTranslate,
    );

    try {
      scenario.board.runUntil(0);
      scenario.board.runUntil(3);
      // 预热已让旧 pc=0/pc=1 都进入 direct program；否则“陈旧下一块”根本不可能发生。
      const pcs = [...(scenario.jit.direct?.pcs ?? [])];

      expect(pcs).toContain(0);
      expect(pcs).toContain(1);
      expectDirect(scenario);
      const spy = spyPublish(scenario);

      try {
        scenario.board.runUntil(5);
        expect(spy.phases).toContain('instruction');
      } finally {
        spy.restore();
      }

      const afterInvalidation = records(scenario).filter((record) => record.time >= 4);

      expect(afterInvalidation).toEqual([
        { tag: TRACE_TAG.prefix, a: 0, b: 0, time: 4 },
        { tag: TRACE_TAG.reaction, a: 0, b: 0, time: 4 },
        { tag: TRACE_TAG.freshNext, a: 0, b: 0, time: 4 },
      ]);
      expect(
        records(scenario).some((record) => record.tag === TRACE_TAG.staleNext && record.time >= 4),
      ).toBe(false);
      expectDirect(scenario);
    } finally {
      scenario.board.dispose();
    }
  });

  it('keeps successful boundary prefixes and never re-executes after a body throws', () => {
    const scenario = createScenario(errorBoundaryModel(), errorBoundaryTranslate);
    let spy: PublishSpy | undefined;

    try {
      scenario.board.runUntil(0);
      scenario.board.runUntil(4);
      expectDirect(scenario);
      spy = spyPublish(scenario);

      expect(() => scenario.board.runUntil(30)).toThrow(/boundary failed/);
      expect(spy.phases).toContain('prefix');
      expect(scenario.board.status).toBe('faulted');

      const beforeRetry = records(scenario);

      expect(beforeRetry).toEqual([
        { tag: TRACE_TAG.prefix, a: 0, b: 0, time: 5 },
        // A 的 state/memory 成功前缀保留；B 抛错，C 不执行。
        { tag: TRACE_TAG.boundaryGood, a: 0, b: 0, time: 5 },
      ]);
      expect(scenario.instance.states.get('prefixCount')).toBe(1);
      expect(scenario.instance.stateResources.get('prefixCount')!.version).toBe(1);
      expect(scenario.instance.states.get('x')).toBe(99);
      expect(scenario.instance.memories.get('marker')![0]).toBe(7);

      // 已 fault 的板不会再次 commit 或执行 prefix。
      expect(() => scenario.board.runUntil(31)).toThrow(/Board is faulted/);
      expect(records(scenario)).toEqual(beforeRetry);
      expect(scenario.instance.states.get('prefixCount')).toBe(1);
      expectDirect(scenario);
    } finally {
      spy?.restore();
      scenario.board.dispose();
    }
  });
});

type ReactionMode = 'capture-before' | 'capture-fail' | 'body-fail';

function reactionModel(mode: ReactionMode): DeviceIR {
  const builder = traceModel(`Reactions_${mode.replaceAll('-', '_')}`);

  builder.state({ name: 'x', type: types.number, initial: 0 });
  builder.state({ name: 'armed', type: types.number, initial: 0 });
  builder.state({ name: 'warmup', type: types.number, initial: 0 });
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  builder.start((body) => {
    body.loop((loop) => {
      loop.wait(4);
      loop.writeState('armed', loop.constant(types.number, 1));
      loop.wait(100);
    });
  });
  builder.reaction(
    {
      name: 'a',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'aPrevious',
      current: 'aCurrent',
      captures: [{ name: 'capturedX', type: types.number }],
    },
    {
      capturedX: (capture) => {
        if (mode === 'capture-fail')
          capture.assert(capture.constant(types.bool, false), (message) =>
            message.constant(types.string, 'capture failed'),
          );
        capture.returnValue(capture.readState('x', types.number));
      },
    },
    (body, bindings) => {
      trace(body, TRACE_TAG.captureA, bindings.captures.capturedX);
      body.writeState('x', body.constant(types.number, 99));
    },
  );
  builder.reaction(
    {
      name: 'b',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'bPrevious',
      current: 'bCurrent',
      captures: [{ name: 'capturedX', type: types.number }],
    },
    {
      capturedX: (capture) => capture.returnValue(capture.readState('x', types.number)),
    },
    (body, bindings) => {
      trace(body, TRACE_TAG.captureB, bindings.captures.capturedX);
      if (mode === 'body-fail')
        body.assert(body.constant(types.bool, false), (message) =>
          message.constant(types.string, 'body failed'),
        );
    },
  );
  if (mode === 'body-fail')
    builder.reaction(
      {
        name: 'c',
        sourcePath: ['drive', 'sample', 'level'],
        sourceType: types.logic,
        previous: 'cPrevious',
        current: 'cCurrent',
        captures: [{ name: 'capturedX', type: types.number }],
      },
      {
        capturedX: (capture) => capture.returnValue(capture.readState('x', types.number)),
      },
      (body, bindings) => {
        trace(body, TRACE_TAG.captureC, bindings.captures.capturedX);
      },
    );
  return builder.finish();
}

const reactionTranslate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: 0 }, (body) => {
    const zero = body.constant(types.number, 0);
    const one = body.constant(types.number, 1);
    const armed = body.readState('armed', types.number);

    body.if(body.equal(types.number, armed, zero), (warm) => {
      warm.writeState(
        'warmup',
        warm.add(warm.readState('warmup', types.number), warm.constant(types.number, 1)),
      );
    });
    body.if(body.equal(types.number, armed, one), (prefix) => {
      trace(prefix, TRACE_TAG.prefix);
      const high = prefix.combineIntents(
        prefix.resistor(prefix.pin('mid'), prefix.constant(types.number, 1000)),
      );
      prefix.writeIntent('drive', high);
    });

    const duration = body.select(
      types.number,
      body.equal(types.number, armed, zero),
      (warm) => warm.constant(types.number, 1),
      (next) => next.constant(types.number, 100),
    );
    body.elapse(duration);
  });
  return block.finish();
};

function addWarmupStates(builder: DeviceBuilder): void {
  builder.state({ name: 'armed', type: types.number, initial: 0 });
  builder.state({ name: 'warmup', type: types.number, initial: 0 });
}

function startArmed(builder: DeviceBuilder, wake: number): void {
  builder.start((body) => {
    body.loop((loop) => {
      loop.wait(wake);
      loop.writeState('armed', loop.constant(types.number, 1));
      loop.wait(100);
    });
  });
}

function horizonModel(): DeviceIR {
  const builder = traceModel('PrefixHorizon');

  addWarmupStates(builder);
  builder.state({ name: 'kick', type: types.number, initial: 0 });
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  startArmed(builder, 5);
  builder.reaction(
    {
      name: 'kickAtPrefix',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'kickPrevious',
      current: 'kickCurrent',
      captures: [],
    },
    {},
    (body, bindings) => {
      body.if(body.equal(types.logic, bindings.current, types.logic.members.high), (high) => {
        high.writeState('kick', high.constant(types.number, 1));
        trace(high, TRACE_TAG.reaction);
      });
    },
  );
  builder.on({ name: 'kicked', sourcePath: ['kick'] }, (body) => {
    trace(body, TRACE_TAG.kickProcess);
    body.wait(1);
    trace(body, TRACE_TAG.kickLater);
  });
  return builder.finish();
}

const horizonTranslate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: 0 }, (body) => {
    const zero = body.constant(types.number, 0);
    const one = body.constant(types.number, 1);
    const two = body.constant(types.number, 2);
    const armed = body.readState('armed', types.number);

    body.if(body.equal(types.number, armed, zero), (warm) => {
      warm.writeState(
        'warmup',
        warm.add(warm.readState('warmup', types.number), warm.constant(types.number, 1)),
      );
    });
    body.if(body.equal(types.number, armed, one), (prefix) => {
      prefix.writeState('armed', two);
      trace(prefix, TRACE_TAG.prefix);
      const high = prefix.combineIntents(
        prefix.resistor(prefix.pin('mid'), prefix.constant(types.number, 1000)),
      );
      prefix.writeIntent('drive', high);
    });
    body.if(body.equal(types.number, armed, two), (next) => {
      trace(next, TRACE_TAG.nextPrefix);
    });

    const duration = body.select(
      types.number,
      body.equal(types.number, armed, zero),
      (warm) => warm.constant(types.number, 1),
      (notWarm) =>
        notWarm.select(
          types.number,
          notWarm.equal(types.number, armed, one),
          (prefix) => prefix.constant(types.number, CYCLE_PS),
          (next) => next.constant(types.number, 100),
        ),
    );

    body.elapse(duration);
  });
  return block.finish();
};

function pcChangeModel(): DeviceIR {
  const builder = traceModel('PrefixPcChange');

  addWarmupStates(builder);
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  startArmed(builder, 4);
  builder.reaction(
    {
      name: 'changePc',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'pcPrevious',
      current: 'pcCurrent',
      captures: [],
    },
    {},
    (body, bindings) => {
      body.if(body.equal(types.logic, bindings.current, types.logic.members.high), (high) => {
        high.writeState('pc', high.constant(types.number, 1));
        trace(high, TRACE_TAG.reaction);
      });
    },
  );
  return builder.finish();
}

const pcChangeTranslate: JitTranslate = ({ pc }, block) => {
  if (pc !== 0) {
    block.instruction({ pc, nextPc: 0 }, (body) => {
      const armed = body.readState('armed', types.number);

      body.if(body.equal(types.number, armed, body.constant(types.number, 2)), (next) => {
        trace(next, TRACE_TAG.nextPc);
      });
      const duration = body.select(
        types.number,
        body.equal(types.number, armed, body.constant(types.number, 0)),
        (warm) => warm.constant(types.number, 1),
        (next) => next.constant(types.number, 100),
      );
      body.elapse(duration);
    });
    return block.finish();
  }
  block.instruction({ pc, nextPc: 0 }, (body) => {
    const zero = body.constant(types.number, 0);
    const one = body.constant(types.number, 1);
    const two = body.constant(types.number, 2);
    const armed = body.readState('armed', types.number);

    body.if(body.equal(types.number, armed, zero), (warm) => {
      warm.writeState(
        'warmup',
        warm.add(warm.readState('warmup', types.number), warm.constant(types.number, 1)),
      );
      // 预热同时翻译 pc=1；但正式 prefix 分支不写 pc，下一 PC 只由 reaction 决定。
      warm.writeState('pc', one);
    });
    body.if(body.equal(types.number, armed, one), (prefix) => {
      prefix.writeState('armed', two);
      trace(prefix, TRACE_TAG.prefix);
      const high = prefix.combineIntents(
        prefix.resistor(prefix.pin('mid'), prefix.constant(types.number, 1000)),
      );
      prefix.writeIntent('drive', high);
    });
    body.if(body.equal(types.number, armed, two), (stale) => {
      trace(stale, TRACE_TAG.staleNext);
    });

    const duration = body.select(
      types.number,
      body.equal(types.number, armed, zero),
      (warm) => warm.constant(types.number, 1),
      (notWarm) =>
        notWarm.select(
          types.number,
          notWarm.equal(types.number, armed, one),
          (prefix) => prefix.constant(types.number, CYCLE_PS),
          (next) => next.constant(types.number, 100),
        ),
    );

    body.elapse(duration);
  });
  return block.finish();
};

function instructionInvalidationModel(): DeviceIR {
  const builder = traceModel('InstructionInvalidation');

  addWarmupStates(builder);
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  startArmed(builder, 4);
  builder.reaction(
    {
      name: 'replaceCode',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'codePrevious',
      current: 'codeCurrent',
      captures: [],
    },
    {},
    (body, bindings) => {
      body.if(body.equal(types.logic, bindings.current, types.logic.members.high), (high) => {
        trace(high, TRACE_TAG.reaction);
        high.store8('code', high.constant(types.number, 1), high.constant(types.number, 1));
      });
    },
  );
  return builder.finish();
}

const instructionInvalidationTranslate: JitTranslate = ({ pc, code }, block) => {
  if (pc !== 0) {
    const version = code[1] ?? 0;

    block.instruction({ pc, nextPc: 0 }, (body) => {
      trace(body, version === 0 ? TRACE_TAG.staleNext : TRACE_TAG.freshNext);
      body.elapse(body.constant(types.number, 1));
    });
    return block.finish();
  }

  block.instruction({ pc, nextPc: 1 }, (body) => {
    const zero = body.constant(types.number, 0);
    const one = body.constant(types.number, 1);
    const two = body.constant(types.number, 2);
    const armed = body.readState('armed', types.number);

    body.if(body.equal(types.number, armed, zero), (warm) => {
      warm.writeState(
        'warmup',
        warm.add(warm.readState('warmup', types.number), warm.constant(types.number, 1)),
      );
    });
    body.if(body.equal(types.number, armed, one), (publish) => {
      publish.writeState('armed', two);
      trace(publish, TRACE_TAG.prefix);
      const high = publish.combineIntents(
        publish.resistor(publish.pin('mid'), publish.constant(types.number, 1000)),
      );
      publish.writeIntent('drive', high);
    });
    // 零时长终结符：没有 parked suffix，publishPending 在指令结束处交还运行时。
    body.elapse(zero);
  });
  return block.finish();
};

function errorBoundaryModel(): DeviceIR {
  const builder = traceModel('BoundaryError');

  addWarmupStates(builder);
  builder.memory({ name: 'marker', length: 1, public: true });
  builder.state({ name: 'prefixCount', type: types.number, initial: 0 });
  builder.state({ name: 'x', type: types.number, initial: 0 });
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  startArmed(builder, 5);
  builder.reaction(
    {
      name: 'goodPrefix',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'goodPrevious',
      current: 'goodCurrent',
      captures: [],
    },
    {},
    (body, bindings) => {
      body.if(body.equal(types.logic, bindings.current, types.logic.members.high), (high) => {
        trace(high, TRACE_TAG.boundaryGood);
        high.writeState('x', high.constant(types.number, 99));
        high.store8('marker', high.constant(types.number, 0), high.constant(types.number, 7));
      });
    },
  );
  builder.reaction(
    {
      name: 'throwingBody',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'throwPrevious',
      current: 'throwCurrent',
      captures: [],
    },
    {},
    (body, bindings) => {
      body.if(body.equal(types.logic, bindings.current, types.logic.members.high), (high) => {
        high.assert(high.constant(types.bool, false), (message) =>
          message.constant(types.string, 'boundary failed'),
        );
      });
    },
  );
  builder.reaction(
    {
      name: 'afterThrow',
      sourcePath: ['drive', 'sample', 'level'],
      sourceType: types.logic,
      previous: 'afterPrevious',
      current: 'afterCurrent',
      captures: [],
    },
    {},
    (body, bindings) => {
      body.if(body.equal(types.logic, bindings.current, types.logic.members.high), (high) => {
        trace(high, TRACE_TAG.boundaryAfter);
      });
    },
  );
  return builder.finish();
}

const errorBoundaryTranslate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: 0 }, (body) => {
    const zero = body.constant(types.number, 0);
    const one = body.constant(types.number, 1);
    const two = body.constant(types.number, 2);
    const armed = body.readState('armed', types.number);

    body.if(body.equal(types.number, armed, zero), (warm) => {
      warm.writeState(
        'warmup',
        warm.add(warm.readState('warmup', types.number), warm.constant(types.number, 1)),
      );
    });
    body.if(body.equal(types.number, armed, one), (prefix) => {
      prefix.writeState('armed', two);
      prefix.writeState(
        'prefixCount',
        prefix.add(prefix.readState('prefixCount', types.number), prefix.constant(types.number, 1)),
      );
      trace(prefix, TRACE_TAG.prefix);
      const high = prefix.combineIntents(
        prefix.resistor(prefix.pin('mid'), prefix.constant(types.number, 1000)),
      );
      prefix.writeIntent('drive', high);
    });
    body.if(body.equal(types.number, armed, two), (after) => {
      trace(after, TRACE_TAG.nextPrefix);
    });

    const duration = body.select(
      types.number,
      body.equal(types.number, armed, zero),
      (warm) => warm.constant(types.number, 1),
      (notWarm) =>
        notWarm.select(
          types.number,
          notWarm.equal(types.number, armed, one),
          (prefix) => prefix.constant(types.number, CYCLE_PS),
          (next) => next.constant(types.number, 100),
        ),
    );

    body.elapse(duration);
  });
  return block.finish();
};
