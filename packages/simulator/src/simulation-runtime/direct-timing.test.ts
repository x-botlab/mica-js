import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it, vi } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import { genericBodyStats } from '../runtime/execution';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import { SimulationError, type BoardOptions } from '../types';
import type { JitDelay, JitDirectTiming, JitLoopAddress, JitOptions, JitTranslate } from '../types';

/**
 * `compileBody` is wrapped only to force a generic compile failure in one scenario. Every
 * other call delegates to the real compiler.
 */
const compilerState = vi.hoisted(() => ({ failGenericBody: false }));
vi.mock('@mica-js/compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mica-js/compiler')>();
  return {
    ...actual,
    compileBody: (
      region: Parameters<typeof actual.compileBody>[0],
      options?: Parameters<typeof actual.compileBody>[1],
    ) => {
      if (compilerState.failGenericBody) throw new TypeError('generic body compile failure');
      return actual.compileBody(region, options);
    },
  };
});

const CODE = 16;
const SRAM = 32;

interface HarnessOptions {
  readonly name?: string;
  readonly translate: JitTranslate;
  readonly configure?: (builder: ReturnType<typeof createDeviceBuilder>) => void;
  readonly directTiming?: JitDirectTiming;
  readonly translationIdentity?: JitOptions['translationIdentity'];
  readonly directTier?: JitOptions['directTier'];
  readonly shareDirectBodies?: boolean;
  readonly delays?: ReadonlyMap<number, JitDelay>;
  readonly polling?: JitOptions['polling'];
  readonly beforeInstruction?: JitOptions['beforeInstruction'];
  readonly functions?: JitOptions['functions'];
  readonly codeLength?: number;
  readonly execution?: BoardOptions['execution'];
  readonly load?: Uint8Array;
}

interface Harness {
  readonly board: ReturnType<typeof createBoard>;
  readonly instance: Instance;
  readonly jit: Jit;
  readonly dispose: () => void;
}

function createHarness(options: HarnessOptions): Harness {
  const name = options.name ?? 'DirectTiming';
  const builder = createDeviceBuilder({ name });
  builder.memory({ name: 'code', length: options.codeLength ?? CODE });
  builder.memory({ name: 'sram', length: SRAM });
  builder.memory({ name: 'psw', length: 1 });
  for (const state of [
    'pc',
    'prefix',
    'terminal',
    'observed',
    'serviceElapsed',
    'serviceDeadline',
    'clockPs',
    'hookRuns',
  ])
    builder.state({ name: state, type: types.number, initial: 0 });
  builder.state({ name: 'blockedFlag', type: types.bool, initial: false });
  options.configure?.(builder);
  const library = createDeviceLibrary([
    {
      id: name,
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({
          entry: name,
          code: 'code',
          pc: 'pc',
          ...(options.directTiming === undefined ? {} : { directTiming: options.directTiming }),
          ...(options.translationIdentity === undefined
            ? {}
            : { translationIdentity: options.translationIdentity }),
          ...(options.directTier === undefined ? {} : { directTier: options.directTier }),
          ...(options.shareDirectBodies === undefined
            ? {}
            : { shareDirectBodies: options.shareDirectBodies }),
          ...(options.delays === undefined ? {} : { delays: options.delays }),
          ...(options.polling === undefined ? {} : { polling: options.polling }),
          ...(options.beforeInstruction === undefined
            ? {}
            : { beforeInstruction: options.beforeInstruction }),
          ...(options.functions === undefined ? {} : { functions: options.functions }),
          translate: options.translate,
        });
        try {
          context.loadBytes('code', options.load ?? new Uint8Array([1]));
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
    { instances: [{ id: name, type: name }], nets: [] },
    { execution: options.execution ?? 'throughput' },
  );
  const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
  return {
    board,
    instance,
    jit: instance.jits[0]!,
    dispose: () => board.dispose(),
  };
}

function currentPc(instance: Instance): number {
  return instance.states.get('pc') as number;
}

/** A pure prefix, a terminal write, and a stop instruction in one translated block. */
function spanTranslate(mark: boolean): JitTranslate {
  return (input, block) => {
    if (input.pc === 0) {
      block.instruction({ pc: 0, nextPc: 1 }, (body) => {
        body.writeState(
          'prefix',
          body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
        );
        body.elapse(10);
      });
      block.instruction({ pc: 1, nextPc: 2 }, (body) => {
        body.writeState('terminal', body.constant(types.number, 1));
        body.elapse(10);
      });
      block.instruction({ pc: 2, nextPc: 2 }, (body) => body.stop());
      if (mark) input.markDirectSpan?.(0, 2);
    } else if (input.pc === 1) {
      block.instruction({ pc: 1, nextPc: 2 }, (body) => {
        body.writeState('terminal', body.constant(types.number, 1));
        body.elapse(10);
      });
      block.instruction({ pc: 2, nextPc: 2 }, (body) => body.stop());
    } else {
      block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
    }
    return block.finish();
  };
}

interface SpanRun {
  readonly terminal: number;
  readonly prefix: number;
  readonly time: number;
  readonly spans: number;
  readonly spanRuns: number;
  readonly spansRejected: number;
  readonly genericInstructions: number;
}

function spanRun(target: number, options: Partial<HarnessOptions> = {}): SpanRun {
  const harness = createHarness({
    name: 'Span',
    translate: spanTranslate(options.directTiming !== undefined),
    ...options,
  });
  try {
    harness.board.runUntil(target);
    const stats = directJitStats(harness.jit)!;
    return {
      terminal: harness.instance.states.get('terminal') as number,
      prefix: harness.instance.states.get('prefix') as number,
      time: harness.board.time,
      spans: stats.directSpans,
      spanRuns: stats.directSpanRuns,
      spansRejected: stats.directSpanRejected,
      genericInstructions: stats.directGenericInstructions,
    };
  } finally {
    harness.dispose();
  }
}

function service(elapsed = 'clockPs', deadline = 'serviceDeadline'): JitDirectTiming {
  return { service: { elapsed, deadline } };
}

describe('direct span timing', () => {
  it('executes the terminal only when the prefix completes before the host horizon', () => {
    const marked = (target: number): SpanRun => spanRun(target, { directTiming: service() });
    const plain = (target: number): SpanRun => spanRun(target);

    // The terminal starts at 10 ps. At and inside its start boundary it stays unwritten.
    expect(marked(9)).toMatchObject({ terminal: 0, prefix: 1, spanRuns: 0, spans: 1 });
    expect(marked(10)).toMatchObject({ terminal: 0, prefix: 1, spanRuns: 0, spans: 1 });
    expect(marked(11)).toMatchObject({ terminal: 1, prefix: 1, spanRuns: 1, spans: 1 });

    for (const target of [9, 10, 11]) {
      const fused = marked(target);
      const reference = plain(target);
      expect(fused.terminal, `terminal at ${target}`).toBe(reference.terminal);
      expect(fused.prefix, `prefix at ${target}`).toBe(reference.prefix);
      expect(fused.time, `time at ${target}`).toBe(reference.time);
      expect(reference.spanRuns).toBe(0);
      expect(reference.spans).toBe(0);
    }
    // At the exact terminal start the fused route is not selected.
    expect(marked(10).spanRuns).toBe(0);
  });

  it('shortens the horizon with service deadline and elapsed states using a strict bound', () => {
    const run = (clockPs: number, serviceDeadline: number): SpanRun => {
      const harness = createHarness({
        name: 'Service',
        translate: spanTranslate(true),
        directTiming: service(),
      });
      harness.instance.states.set('clockPs', clockPs);
      harness.instance.states.set('serviceDeadline', serviceDeadline);
      try {
        harness.board.runUntil(100);
        const stats = directJitStats(harness.jit)!;
        return {
          terminal: harness.instance.states.get('terminal') as number,
          prefix: harness.instance.states.get('prefix') as number,
          time: harness.board.time,
          spans: stats.directSpans,
          spanRuns: stats.directSpanRuns,
          spansRejected: stats.directSpanRejected,
          genericInstructions: stats.directGenericInstructions,
        };
      } finally {
        harness.dispose();
      }
    };

    // H = t + (deadline - elapsed); prefix end 10 must be strictly below H.
    expect(run(0, 10).spanRuns).toBe(0);
    expect(run(0, 11).spanRuns).toBe(1);
    // Elapsed 5 / deadline 15 makes the absolute service horizon exactly 10.
    expect(run(5, 15).spanRuns).toBe(0);
    expect(run(5, 16).spanRuns).toBe(1);
    // A deadline of zero means no service bound; the host deadline admits.
    expect(run(0, 0).spanRuns).toBe(1);

    // Invalid timing states take the ordinary path and still reach the terminal.
    for (const [clockPs, deadline] of [
      [-1, 100],
      [0, -1],
      [0, 1.5],
      [Number.NaN, 100],
      [0, Number.NaN],
    ]) {
      const invalid = run(clockPs!, deadline!);
      expect(invalid.terminal, `${clockPs}/${deadline}`).toBe(1);
      expect(invalid.spanRuns, `${clockPs}/${deadline}`).toBe(0);
    }
  });

  it('honours the blocked guard and falls back on prefix observers and entry hooks', () => {
    const blocked = (value: boolean): SpanRun => {
      const harness = createHarness({
        name: 'Blocked',
        directTiming: { ...service(), blocked: 'blocked' },
        configure: (builder) => {
          builder.pureFn({ name: 'blocked', params: [], returns: types.bool }, (body) =>
            body.returnValue(body.readState('blockedFlag', types.bool)),
          );
        },
        translate: spanTranslate(true),
      });
      harness.instance.states.set('blockedFlag', value);
      harness.instance.states.set('serviceDeadline', 1_000);
      try {
        harness.board.runUntil(11);
        const stats = directJitStats(harness.jit)!;
        return {
          terminal: harness.instance.states.get('terminal') as number,
          prefix: harness.instance.states.get('prefix') as number,
          time: harness.board.time,
          spans: stats.directSpans,
          spanRuns: stats.directSpanRuns,
          spansRejected: stats.directSpanRejected,
          genericInstructions: stats.directGenericInstructions,
        };
      } finally {
        harness.dispose();
      }
    };
    expect(blocked(false)).toMatchObject({ terminal: 1, spanRuns: 1 });
    expect(blocked(true)).toMatchObject({ terminal: 1, spanRuns: 0 });

    const observed = createHarness({
      name: 'Observed',
      directTiming: service(),
      configure: (builder) => {
        builder.on({ name: 'watchPrefix', sourcePath: ['prefix'] }, (body) => {
          body.writeState('observed', body.readState('prefix', types.number));
        });
      },
      translate: spanTranslate(true),
    });
    try {
      observed.board.runUntil(11);
      const stats = directJitStats(observed.jit)!;
      expect(observed.instance.states.get('terminal')).toBe(1);
      expect(stats.directSpanRuns).toBe(0);
      expect(stats.directSpans).toBe(0);
      expect(observed.instance.states.get('observed')).toBe(1);
    } finally {
      observed.dispose();
    }

    const hooked = createHarness({
      name: 'Hooked',
      directTiming: service(),
      configure: (builder) => {
        builder.derived({ name: 'shouldHook', type: types.bool }, (body) =>
          body.returnValue(
            body.greaterThan(
              body.readState('prefix', types.number),
              body.constant(types.number, 0),
            ),
          ),
        );
        builder.fn({ name: 'enterHook', params: [] }, (body) => {
          body.writeState(
            'hookRuns',
            body.add(body.readState('hookRuns', types.number), body.constant(types.number, 1)),
          );
        });
      },
      beforeInstruction: { when: 'shouldHook', call: 'enterHook' },
      translate: spanTranslate(true),
    });
    try {
      hooked.board.runUntil(11);
      const stats = directJitStats(hooked.jit)!;
      expect(hooked.instance.states.get('terminal')).toBe(1);
      expect(stats.directSpanRuns).toBe(0);
      expect(stats.directSpans).toBe(0);
      // The hook read makes the prefix write an entry barrier for the compiler.
      expect(stats.directSpanRejected).toBeGreaterThan(0);
    } finally {
      hooked.dispose();
    }
  });
});

interface LoopOptions {
  readonly mark?: boolean;
  readonly address?: JitLoopAddress;
  readonly candidateAddress?: JitLoopAddress;
  readonly candidateMemory?: string;
  readonly memory?: string;
  readonly duration?: number;
  readonly counter?: number;
  readonly selector?: number;
  readonly directTiming?: JitDirectTiming;
  readonly blocked?: boolean;
}

function createLoopHarness(options: LoopOptions = {}): Harness {
  const address = options.address ?? { kind: 'constant', offset: 5 };
  const candidate = options.candidateAddress ?? address;
  const candidateMemory = options.candidateMemory ?? options.memory ?? 'sram';
  const memory = options.memory ?? 'sram';
  const duration = options.duration ?? 10;
  const mark = options.mark !== false;
  const translate: JitTranslate = (input, block) => {
    if (input.pc === 0) {
      block.instruction({ pc: 0, nextPc: 2 }, (body) => {
        let offset;
        if (address.kind === 'constant') {
          offset = body.constant(types.number, address.offset);
        } else {
          const selector = body.load8(
            body.memory(address.memory),
            body.constant(types.number, address.offset),
          );
          const masked = body.bitAnd(selector, body.constant(types.number, address.mask));
          offset = body.bitOr(masked, body.constant(types.number, address.bits));
        }
        const counter = body.load8(body.memory(memory), offset);
        const next = body.bitAnd(
          body.subtract(counter, body.constant(types.number, 1)),
          body.constant(types.number, 255),
        );
        body.store8(body.memory(memory), offset, next);
        body.if(body.notEqual(types.number, next, body.constant(types.number, 0)), (yes) => {
          yes.writeState('pc', yes.constant(types.number, 0));
        });
        body.elapse(duration);
      });
      block.instruction({ pc: 2, nextPc: 2 }, (body) => body.stop());
      if (mark)
        input.markDirectLoop?.(0, {
          kind: 'decrement8',
          memory: candidateMemory,
          address: candidate,
        });
    } else {
      block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
    }
    return block.finish();
  };
  const harness = createHarness({
    name: 'Loop',
    translate,
    ...(options.directTiming === undefined && !options.blocked
      ? {}
      : {
          directTiming:
            options.directTiming ??
            ({ ...service(), blocked: 'blocked' } satisfies JitDirectTiming),
        }),
    ...(options.blocked
      ? {
          configure: (builder: ReturnType<typeof createDeviceBuilder>) => {
            builder.pureFn({ name: 'blocked', params: [], returns: types.bool }, (body) =>
              body.returnValue(body.readState('blockedFlag', types.bool)),
            );
          },
        }
      : {}),
  });
  if (options.blocked) harness.instance.states.set('blockedFlag', true);
  if (address.kind === 'maskedByte') {
    harness.instance.memory(address.memory)[address.offset] = options.selector ?? 0;
    const target = (((options.selector ?? 0) & address.mask) | address.bits) >>> 0;
    harness.instance.memory(memory)[target] = (options.counter ?? 0) & 255;
  } else {
    harness.instance.memory(memory)[address.offset] = (options.counter ?? 0) & 255;
  }
  return harness;
}

interface LoopRun {
  readonly pc: number;
  readonly time: number;
  readonly counter: number;
  readonly loops: number;
  readonly loopRounds: number;
  readonly loopsRejected: number;
  readonly candidates: number;
  readonly markAddressRejected: number;
}

function loopRun(target: number, options: LoopOptions = {}): LoopRun {
  const harness = createLoopHarness(options);
  try {
    harness.board.runUntil(target);
    const stats = directJitStats(harness.jit)!;
    const address = options.address ?? { kind: 'constant', offset: 5 };
    const memory = options.memory ?? 'sram';
    const targetAddress =
      address.kind === 'constant'
        ? address.offset
        : (((options.selector ?? 0) & address.mask) | address.bits) >>> 0;
    return {
      pc: currentPc(harness.instance),
      time: harness.board.time,
      counter: harness.instance.memory(memory)[targetAddress]!,
      loops: stats.directLoops,
      loopRounds: stats.directLoopRounds,
      loopsRejected: stats.directLoopRejected,
      candidates: stats.directLoopCandidates,
      markAddressRejected: stats.directLoopMarkRejected.address,
    };
  } finally {
    harness.dispose();
  }
}

describe('direct loop folding', () => {
  it('folds decrement8 rounds and keeps the boundary round exact for every counter value', () => {
    for (const [counter, folded] of [
      [0, 255],
      [1, 0],
      [2, 1],
      [255, 254],
    ] as const) {
      const total = counter === 0 ? 256 : counter;
      const result = loopRun(total * 10, {
        counter,
        directTiming: service(),
      });
      expect(result.counter, `counter ${counter}`).toBe(0);
      expect(result.pc, `counter ${counter}`).toBe(2);
      expect(result.time, `counter ${counter}`).toBe(total * 10);
      expect(result.loopRounds, `counter ${counter}`).toBe(folded);
      expect(result.loops, `counter ${counter}`).toBe(1);
      expect(result.loopsRejected, `counter ${counter}`).toBe(0);
      // One folded range and one real boundary round still execute.
      expect(result.loopRounds, `counter ${counter}`).toBeLessThan(total);
    }

    // An unmarked reference reaches the same counter, PC and time.
    const reference = loopRun(100, { mark: false, counter: 10 });
    const fused = loopRun(100, { counter: 10, directTiming: service() });
    expect(fused).toMatchObject({ counter: reference.counter, pc: reference.pc, time: 100 });
    expect(reference.loops).toBe(0);
    expect(reference.loopRounds).toBe(0);

    // A target inside the loop resumes from the ordinary counter/PC state.
    const middle = loopRun(35, { counter: 10, directTiming: service() });
    expect(middle).toMatchObject({ pc: 0, time: 35, counter: 6, loopRounds: 3 });
    const resumed = createLoopHarness({ counter: 6, directTiming: service() });
    try {
      resumed.board.runUntil(65);
      const stats = directJitStats(resumed.jit)!;
      expect(resumed.instance.memory('sram')[5]).toBe(0);
      expect(currentPc(resumed.instance)).toBe(2);
      expect(stats.directLoopRounds).toBe(5);
    } finally {
      resumed.dispose();
    }
  });

  it('folds maskedByte selectors and rejects only the unproven span/loop cases', () => {
    const address: JitLoopAddress = {
      kind: 'maskedByte',
      memory: 'psw',
      offset: 0,
      mask: 0x18,
      bits: 3,
    };
    const result = loopRun(14, {
      address,
      selector: 0x10,
      counter: 2,
      duration: 7,
      directTiming: service(),
    });
    const target = (0x10 & 0x18) | 3;
    expect(target).toBe(19);
    expect(result).toMatchObject({ counter: 0, pc: 2, time: 14, loopRounds: 1, loops: 1 });

    // A selector that can synthesize an out-of-range address is rejected at attach time.
    const rejectedAddress = loopRun(20, {
      candidateAddress: {
        kind: 'maskedByte',
        memory: 'psw',
        offset: 0,
        mask: 0xff,
        bits: 0xff,
      },
      counter: 2,
      directTiming: service(),
    });
    expect(rejectedAddress.loops).toBe(0);
    expect(rejectedAddress.loopsRejected).toBe(0);
    expect(rejectedAddress.counter).toBe(0);
    expect(rejectedAddress.markAddressRejected).toBe(1);
  });

  it('rejects code memory counters and masked selectors in the runtime marker', () => {
    const codeCounter = loopRun(20, {
      memory: 'sram',
      candidateMemory: 'code',
      counter: 2,
      directTiming: service(),
    });
    expect(codeCounter).toMatchObject({
      counter: 0,
      pc: 2,
      loops: 0,
      loopRounds: 0,
      loopsRejected: 0,
      candidates: 0,
      markAddressRejected: 1,
    });

    const codeSelector = loopRun(20, {
      candidateAddress: {
        kind: 'maskedByte',
        memory: 'code',
        offset: 0,
        mask: 0x03,
        bits: 0,
      },
      counter: 2,
      directTiming: service(),
    });
    expect(codeSelector).toMatchObject({
      counter: 0,
      pc: 2,
      loops: 0,
      loopRounds: 0,
      loopsRejected: 0,
      candidates: 0,
      markAddressRejected: 1,
    });
  });

  it('honours the blocked guard for loop folding', () => {
    const harness = createLoopHarness({ counter: 2, blocked: true });
    try {
      harness.board.runUntil(20);
      const stats = directJitStats(harness.jit)!;
      expect(harness.instance.memory('sram')[5]).toBe(0);
      expect(currentPc(harness.instance)).toBe(2);
      expect(stats.directLoops).toBe(1);
      expect(stats.directLoopRounds).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it('folds only complete spin rounds and matches the unfused time and PC', () => {
    const translate =
      (mark: boolean): JitTranslate =>
      (input, block) => {
        if (input.pc === 0) {
          block.instruction({ pc: 0, nextPc: 0 }, (body) => {
            body.writeState('pc', body.constant(types.number, 0));
            body.elapse(10);
          });
          if (mark) input.markDirectLoop?.(0, { kind: 'spin' });
        } else {
          block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
        }
        return block.finish();
      };
    const run = (
      target: number,
      mark: boolean,
    ): { time: number; pc: number; rounds: number; loops: number; rejected: number } => {
      const harness = createHarness({
        name: 'Spin',
        translate: translate(mark),
        directTiming: service(),
      });
      try {
        harness.board.runUntil(target);
        const stats = directJitStats(harness.jit)!;
        return {
          time: harness.board.time,
          pc: currentPc(harness.instance),
          rounds: stats.directLoopRounds,
          loops: stats.directLoops,
          rejected: stats.directLoopRejected,
        };
      } finally {
        harness.dispose();
      }
    };
    for (const target of [10, 11, 35, 100]) {
      const fused = run(target, true);
      const reference = run(target, false);
      expect(fused.time, `time at ${target}`).toBe(target);
      expect(fused.pc, `pc at ${target}`).toBe(reference.pc);
      expect(fused.time, `fused time at ${target}`).toBe(reference.time);
      expect(fused.rounds, `rounds at ${target}`).toBe(
        target > 10 ? Math.floor((target - 1) / 10) : 0,
      );
      expect(fused.loops).toBe(1);
      expect(fused.rejected).toBe(0);
      expect(reference.rounds).toBe(0);
      expect(reference.loops).toBe(0);
    }
  });
});

describe('direct timing marker validation', () => {
  it('drops malformed span/loop/dependency markers without failing translation', () => {
    let spanCallbacks = 0;
    let loopCallbacks = 0;
    const translate: JitTranslate = (input, block) => {
      for (let pc = 0; pc <= 9; pc++)
        block.instruction({ pc, nextPc: pc === 9 ? 9 : pc + 1 }, (body) => {
          body.elapse(1);
        });
      const span = input.markDirectSpan!;
      span(0, 1);
      span(Number.NaN, 2);
      span(4, 2);
      span(4, 2);
      span(100, 2);
      span(6, 2);
      span(9, 2);
      const loop = input.markDirectLoop!;
      loop(7, { kind: 'bogus' } as never);
      loop(99, { kind: 'spin' });
      loop(2, { kind: 'bogus' } as never);
      loop(2, { kind: 'bogus' } as never);
      loop(5, { kind: 'spin' });
      loop(1, { kind: 'spin' });
      loop(6, { kind: 'spin' });
      loop(3, {
        kind: 'decrement8',
        memory: 'missing',
        address: { kind: 'constant', offset: 0 },
      });
      loop(0, {
        kind: 'decrement8',
        memory: 'sram',
        address: { kind: 'maskedByte', memory: 'code', offset: 0, mask: 1, bits: 0 },
      });
      loop(8, {
        kind: 'decrement8',
        memory: 'sram',
        address: { kind: 'maskedByte', memory: 'psw', offset: 0, mask: 0xff, bits: 0xff },
      });
      const dependencies = input.markTranslationDependencies!;
      dependencies([
        { offset: 0, length: 1 },
        { offset: 5, length: 0 },
      ]);
      dependencies([
        { offset: -1, length: 1 },
        { offset: 0, length: 1.5 },
        { offset: 'x', length: 1 } as never,
      ]);
      dependencies([{ offset: 0, length: 999 }]);
      dependencies('bad' as never);
      spanCallbacks += 7;
      loopCallbacks += 10;
      return block.finish();
    };
    const harness = createHarness({
      name: 'Rejections',
      translate,
      directTiming: service('serviceElapsed', 'serviceDeadline'),
      translationIdentity: { abi: 'test', configuration: 'default' },
      polling: [
        { pc: 4, predicate: 'awake' },
        { pc: 5, predicate: 'awake' },
      ],
      configure: (builder) => {
        builder.pureFn({ name: 'awake', params: [], returns: types.bool }, (body) =>
          body.returnValue(body.constant(types.bool, true)),
        );
      },
      delays: new Map([[1, { counter: 'pc', cycles: 5 }]]),
    });
    try {
      harness.board.runUntil(1);
      expect(harness.board.status).toBe('ready');
      const stats = directJitStats(harness.jit)!;
      expect(stats.directSpanCallbacks).toBe(spanCallbacks);
      expect(stats.directLoopCallbacks).toBe(loopCallbacks);
      expect(stats.directSpanCandidates).toBe(0);
      expect(stats.directLoopCandidates).toBe(0);
      expect(stats.directSpanMarkRejected).toEqual({
        invalid: 2,
        unknownPc: 1,
        duplicate: 1,
        discontinuous: 1,
        notAdmitted: 1,
        conflict: 1,
      });
      expect(stats.directLoopMarkRejected).toEqual({
        invalid: 2,
        unknownPc: 1,
        duplicate: 1,
        notAdmitted: 1,
        delayConflict: 1,
        conflict: 1,
        address: 3,
      });
      expect(stats.directDependencyMarkRejected).toEqual({ invalidRange: 4, outsideView: 1 });
      expect(currentPc(harness.instance)).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it('fails closed when a declared quiet guard cannot be resolved at binding time', () => {
    const harness = createHarness({
      name: 'FailClosedGuard',
      directTiming: { ...service(), blocked: 'blocked' },
      configure: (builder) => {
        builder.pureFn({ name: 'blocked', params: [], returns: types.bool }, (body) =>
          body.returnValue(body.readState('blockedFlag', types.bool)),
        );
      },
      translate: spanTranslate(true),
    });
    try {
      const declaration = harness.instance.declarations.get('blocked')!;
      harness.instance.declarations.set('blocked', {
        ...declaration,
        pure: false,
      } as typeof declaration);
      harness.board.runUntil(11);
      const stats = directJitStats(harness.jit)!;
      // The marker was collected, but the unresolvable guard kept it out of the session and
      // omitted the compiler timing binding entirely.
      expect(stats.directSpanCandidates).toBe(1);
      expect(stats.directSpans).toBe(0);
      expect(stats.directSpanRuns).toBe(0);
      expect(harness.instance.states.get('terminal')).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it('does not expose timing or dependency callbacks without their options', () => {
    const seen: (boolean | undefined)[] = [];
    const translate: JitTranslate = (input, block) => {
      seen.push(
        input.markDirectSpan === undefined,
        input.markDirectLoop === undefined,
        input.markTranslationDependencies === undefined,
      );
      block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      return block.finish();
    };
    const harness = createHarness({ name: 'NoMarks', translate });
    try {
      harness.board.runUntil(1);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(Boolean)).toBe(true);
      expect(directJitStats(harness.jit)!.directSpanCallbacks).toBe(0);
      expect(directJitStats(harness.jit)!.directLoopCallbacks).toBe(0);
    } finally {
      harness.dispose();
    }
  });
});

const noopTranslate: JitTranslate = (_input, block) => block.finish();

function validationModel() {
  const builder = createDeviceBuilder({ name: 'Validation' });
  builder.memory({ name: 'code', length: CODE });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'flag', type: types.bool, initial: false });
  builder.pureFn({ name: 'pureBool', params: [], returns: types.bool }, (body) =>
    body.returnValue(body.constant(types.bool, false)),
  );
  builder.pureFn({ name: 'pureNumber', params: [], returns: types.number }, (body) =>
    body.returnValue(body.constant(types.number, 0)),
  );
  builder.pureFn(
    { name: 'pureParam', params: [{ name: 'value', type: types.number }], returns: types.bool },
    (body) => body.returnValue(body.constant(types.bool, false)),
  );
  builder.fn({ name: 'fnBool', params: [], returns: types.bool }, (body) =>
    body.returnValue(body.constant(types.bool, false)),
  );
  return builder.finish();
}

function attachFailure(options: Record<string, unknown>): SimulationError | undefined {
  const model = validationModel();
  const library = createDeviceLibrary([
    {
      id: 'validation',
      model,
      create: (context) => {
        const registration = context.attachJit({
          entry: 'validation',
          code: 'code',
          pc: 'pc',
          translate: noopTranslate,
          ...options,
        } as unknown as JitOptions);
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  try {
    const board = createBoard(library, {
      instances: [{ id: 'validation', type: 'validation' }],
      nets: [],
    });
    board.dispose();
    return undefined;
  } catch (cause) {
    return cause as SimulationError;
  }
}

/** The board wraps factory failures; the attach diagnostic remains in the cause chain. */
function hasDiagnostic(value: unknown, code: string, phase?: string): boolean {
  let current: SimulationError | undefined = value instanceof SimulationError ? value : undefined;
  while (current !== undefined) {
    if (current.code === code && (phase === undefined || current.diagnostic.phase === phase))
      return true;
    const cause = current.diagnostic.cause;
    current = cause instanceof SimulationError ? cause : undefined;
  }
  return false;
}

function expectAttachFailure(options: Record<string, unknown>, label: string): void {
  const error = attachFailure(options);
  expect(error, label).toBeInstanceOf(SimulationError);
  expect(hasDiagnostic(error, 'INVALID_BINDING'), label).toBe(true);
}

describe('direct timing attach validation', () => {
  it('rejects malformed timing, identity and tier options', () => {
    expectAttachFailure(
      { directTiming: { service: { elapsed: 'pc', deadline: 'pc', extra: 1 } } },
      'service extra field',
    );
    expectAttachFailure({ directTiming: { service: { elapsed: 'pc' } } }, 'missing pair');
    expectAttachFailure(
      { directTiming: { service: { elapsed: 'flag', deadline: 'pc' } } },
      'non-number state',
    );
    expectAttachFailure(
      { directTiming: { service: { elapsed: 'missing', deadline: 'pc' } } },
      'unknown state',
    );
    expectAttachFailure({ directTiming: { blocked: 'pureBool' } }, 'blocked requires service');
    expectAttachFailure(
      { directTiming: { service: { elapsed: 'pc', deadline: 'pc' }, blocked: 'pureNumber' } },
      'blocked return',
    );
    expectAttachFailure(
      { directTiming: { service: { elapsed: 'pc', deadline: 'pc' }, blocked: 'pureParam' } },
      'blocked signature',
    );
    expectAttachFailure(
      { directTiming: { service: { elapsed: 'pc', deadline: 'pc' }, blocked: 'fnBool' } },
      'blocked purity',
    );
    expectAttachFailure(
      { directTiming: { service: { elapsed: 'pc', deadline: 'pc' }, blocked: '' } },
      'blocked empty',
    );
    expectAttachFailure({ directTiming: [] }, 'timing kind');

    expectAttachFailure({ translationIdentity: { abi: 'x' } }, 'identity missing');
    expectAttachFailure({ translationIdentity: { abi: '', configuration: 'x' } }, 'identity empty');
    expectAttachFailure(
      { translationIdentity: { abi: 'x', configuration: 'y', extra: 1 } },
      'identity extra',
    );

    for (const promoteAfter of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])
      expectAttachFailure({ directTier: { promoteAfter } }, `promoteAfter ${promoteAfter}`);
  });

  it('rejects a blocked guard without service and registers no JIT', () => {
    const model = validationModel();
    let failure: unknown;
    const library = createDeviceLibrary([
      {
        id: 'blocked-only',
        model,
        create: (context) => {
          try {
            context.attachJit({
              entry: 'blocked-only',
              code: 'code',
              pc: 'pc',
              directTiming: { blocked: 'pureBool' },
              translate: noopTranslate,
            });
          } catch (cause) {
            failure = cause;
          }
          return { sync() {}, dispose() {} };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'blocked-only', type: 'blocked-only' }],
      nets: [],
    });
    try {
      expect(failure).toBeInstanceOf(SimulationError);
      expect(hasDiagnostic(failure, 'INVALID_BINDING')).toBe(true);
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      expect(instance.jits).toHaveLength(0);
    } finally {
      board.dispose();
    }
  });

  it('stores frozen validated options', () => {
    const model = validationModel();
    const library = createDeviceLibrary([
      {
        id: 'valid',
        model,
        create: (context) => {
          const registration = context.attachJit({
            entry: 'valid',
            code: 'code',
            pc: 'pc',
            directTiming: { service: { elapsed: 'pc', deadline: 'pc' }, blocked: 'pureBool' },
            translationIdentity: { abi: 'abi-1', configuration: 'clock-1' },
            directTier: { promoteAfter: 3 },
            translate: noopTranslate,
          });
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'valid', type: 'valid' }],
      nets: [],
    });
    try {
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const options = instance.jits[0]!.options;
      expect(options.directTiming).toEqual({
        service: { elapsed: 'pc', deadline: 'pc' },
        blocked: 'pureBool',
      });
      expect(Object.isFrozen(options.directTiming)).toBe(true);
      expect(Object.isFrozen(options.directTiming!.service)).toBe(true);
      expect(options.translationIdentity).toEqual({ abi: 'abi-1', configuration: 'clock-1' });
      expect(Object.isFrozen(options.translationIdentity)).toBe(true);
      expect(options.directTier).toEqual({ promoteAfter: 3 });
      expect(Object.isFrozen(options.directTier)).toBe(true);
    } finally {
      board.dispose();
    }
  });
});

describe('lazy generic bodies', () => {
  it('never compiles a generic body for a Direct-resident workload', () => {
    const before = genericBodyStats().compiled;
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: 0 }, (body) => {
        body.writeState(
          'prefix',
          body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const harness = createHarness({ name: 'LazyDirect', translate });
    try {
      harness.board.runUntil(20);
      expect(harness.instance.states.get('prefix')).toBe(20);
      expect(genericBodyStats().compiled).toBe(before);
    } finally {
      harness.dispose();
    }
  });

  it('compiles a generic body for a fallback and preserves the PC/state on failure', () => {
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: 0 }, (body) => {
        body.writeState(
          'prefix',
          body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const before = genericBodyStats().compiled;
    const fallback = createHarness({
      name: 'LazyFallback',
      translate,
      execution: 'precise',
    });
    try {
      fallback.board.runUntil(1);
      expect(fallback.instance.states.get('prefix')).toBe(1);
      expect(genericBodyStats().compiled).toBeGreaterThan(before);
    } finally {
      fallback.dispose();
    }

    const failing = createHarness({
      name: 'LazyFailure',
      translate,
      execution: 'precise',
    });
    try {
      compilerState.failGenericBody = true;
      let error: SimulationError | undefined;
      try {
        failing.board.runUntil(1);
      } catch (cause) {
        error = cause as SimulationError;
      }
      expect(error).toBeInstanceOf(SimulationError);
      expect(hasDiagnostic(error, 'JIT_FAILED', 'translate')).toBe(true);
      expect(failing.instance.states.get('pc')).toBe(0);
      expect(failing.instance.states.get('prefix')).toBe(0);
    } finally {
      compilerState.failGenericBody = false;
      failing.dispose();
    }
  });
});
describe('direct artifact reuse', () => {
  it('reuses instruction artifacts across structurally equal boards', () => {
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: 0 }, (body) => {
        body.writeState(
          'prefix',
          body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const first = createHarness({ name: 'ArtifactReuse', translate });
    const second = createHarness({ name: 'ArtifactReuse', translate });
    try {
      const beforeSecond = directJitStats(second.jit);
      expect(beforeSecond).toBeUndefined();
      first.board.runUntil(10);
      const firstStats = directJitStats(first.jit)!;
      second.board.runUntil(10);
      const secondStats = directJitStats(second.jit)!;

      expect(second.instance.states.get('prefix')).toBe(first.instance.states.get('prefix'));
      expect(second.board.time).toBe(first.board.time);
      expect(firstStats.directBodyBytes + firstStats.directArtifactInstructionHits).toBeGreaterThan(
        0,
      );
      // Deltas are per JIT, so prior process-wide artifact hits cannot satisfy this.
      expect(
        secondStats.directArtifactInstructionHits -
          (beforeSecond?.directArtifactInstructionHits ?? 0),
      ).toBeGreaterThan(0);
      expect(secondStats.directArtifactInstructionMisses).toBe(0);
      expect(secondStats.directBodyBytes).toBe(0);
    } finally {
      second.dispose();
      first.dispose();
    }
  });
});
