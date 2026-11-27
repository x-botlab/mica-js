import { createDeviceBuilder, types, type DeviceBuilder } from '@mica-js/device-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats, readJitBatchStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type {
  BoardOptions,
  JitBatchMark,
  JitCodeMetadata,
  JitOptions,
  JitTranslate,
} from '../types';

const CODE_LENGTH = 16;
const DATA_LENGTH = 256;
const STEP = 10;
const CHECKPOINT_EXPERIMENT = Symbol.for('mica-js.simulator/checkpoint-experiment');
const previousDiagnostics = (globalThis as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT];

beforeAll(() => {
  (globalThis as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT] = {
    ...(typeof previousDiagnostics === 'object' && previousDiagnostics !== null
      ? previousDiagnostics
      : {}),
    diagnostics: true,
  };
});

afterAll(() => {
  if (previousDiagnostics === undefined)
    delete (globalThis as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT];
  else (globalThis as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT] = previousDiagnostics;
});

type Effect = 'advance' | 'fill' | 'copy';

interface HarnessOptions {
  readonly effect?: Effect;
  readonly batch: boolean;
  readonly limit?: number;
  readonly cpuQuantum?: number;
  readonly execution?: BoardOptions['execution'];
  readonly translate?: JitTranslate;
  readonly configure?: (builder: DeviceBuilder) => void;
  readonly directTiming?: JitOptions['directTiming'];
  readonly delays?: JitOptions['delays'];
  readonly polling?: JitOptions['polling'];
  readonly beforeInstruction?: JitOptions['beforeInstruction'];
  readonly codeMetadata?: JitOptions['codeMetadata'];
  readonly directTier?: JitOptions['directTier'];
  readonly shareDirectArtifacts?: boolean;
  readonly shareDirectBodies?: boolean;
  readonly code?: Uint8Array;
  readonly stopBefore?: string;
  readonly pcInitial?: number;
}

interface Harness {
  readonly board: ReturnType<typeof createBoard>;
  readonly instance: Instance;
  readonly jit: Jit;
  readonly translations: number[];
  readonly dispose: () => void;
}

let serial = 0;

function effectTranslate(effect: Effect, limit: number, stopBefore?: string): JitTranslate {
  return (input, block) => {
    if (input.pc === 0) {
      block.instruction({ pc: 0, nextPc: 1 }, (body) => {
        const cursor = body.readState('cursor', types.number);
        body.if(body.lessThan(cursor, body.constant(types.number, limit)), (step) => {
          if (effect === 'fill') step.store8('dst', cursor, 42);
          else if (effect === 'copy') step.store8('dst', cursor, step.load8('src', cursor));
          step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
          step.redirect(step.constant(types.number, 0), step.constant(types.number, STEP));
        });
      });
      const mark: JitBatchMark = stopBefore === undefined ? { pc: 0 } : { pc: 0, stopBefore };
      input.markBatchLoop?.(mark);
    } else {
      block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
    }
    return block.finish();
  };
}

function createHarness(options: HarnessOptions): Harness {
  const id = `JitBatch${serial++}`;
  const translations: number[] = [];
  const translate: JitTranslate =
    options.translate ??
    ((input, block) => {
      translations.push(input.pc);
      return effectTranslate(
        options.effect ?? 'advance',
        options.limit ?? DATA_LENGTH,
        options.stopBefore,
      )(input, block);
    });
  const builder = createDeviceBuilder({ name: id });
  builder.memory({ name: 'code', length: CODE_LENGTH });
  builder.memory({ name: 'src', length: DATA_LENGTH });
  builder.memory({ name: 'dst', length: DATA_LENGTH });
  builder.state({ name: 'pc', type: types.number, initial: options.pcInitial ?? 0 });
  builder.state({ name: 'cursor', type: types.number, initial: 0 });
  builder.state({ name: 'stopAt', type: types.number, initial: 0 });
  builder.state({ name: 'busy', type: types.number, initial: 2 });
  options.configure?.(builder);
  const library = createDeviceLibrary([
    {
      id,
      model: builder.finish(),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          translate,
          ...(options.directTiming === undefined ? {} : { directTiming: options.directTiming }),
          ...(options.delays === undefined ? {} : { delays: options.delays }),
          ...(options.polling === undefined ? {} : { polling: options.polling }),
          ...(options.beforeInstruction === undefined
            ? {}
            : { beforeInstruction: options.beforeInstruction }),
          ...(options.codeMetadata === undefined ? {} : { codeMetadata: options.codeMetadata }),
          ...(options.directTier === undefined ? {} : { directTier: options.directTier }),
          ...(options.shareDirectArtifacts === undefined
            ? {}
            : { shareDirectArtifacts: options.shareDirectArtifacts }),
          ...(options.shareDirectBodies === undefined
            ? {}
            : { shareDirectBodies: options.shareDirectBodies }),
        });
        try {
          context.loadBytes('code', options.code ?? new Uint8Array([1]));
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
    { instances: [{ id, type: id }], nets: [] },
    {
      execution: options.execution ?? 'throughput',
      ...(options.cpuQuantum === undefined ? {} : { cpuQuantum: options.cpuQuantum }),
      ...(options.batch ? { batchExecution: true } : {}),
    },
  );
  const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
  instance.memory('src').set(Uint8Array.from({ length: DATA_LENGTH }, (_, index) => index));
  return {
    board,
    instance,
    jit: instance.jits[0]!,
    translations,
    dispose: () => board.dispose(),
  };
}

interface Snapshot {
  readonly cursor: number;
  readonly pc: number;
  readonly time: number;
  readonly src: readonly number[];
  readonly dst: readonly number[];
}

function snapshot(harness: Harness): Snapshot {
  return {
    cursor: harness.instance.states.get('cursor') as number,
    pc: harness.instance.states.get('pc') as number,
    time: harness.board.time,
    src: [...harness.instance.memory('src')],
    dst: [...harness.instance.memory('dst')],
  };
}

function runPair(
  options: Omit<HarnessOptions, 'batch'>,
  target: number,
): { enabled: Snapshot; reference: Snapshot; enabledHarness: Harness; referenceHarness: Harness } {
  const enabledHarness = createHarness({ ...options, batch: true });
  const referenceHarness = createHarness({ ...options, batch: false });
  enabledHarness.board.runUntil(target);
  referenceHarness.board.runUntil(target);
  return {
    enabled: snapshot(enabledHarness),
    reference: snapshot(referenceHarness),
    enabledHarness,
    referenceHarness,
  };
}

describe('JIT batch execution', () => {
  it('runs one Direct iteration after each rejected fill plan', () => {
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      {
        translate(input, block) {
          block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => {
            const cursor = body.readState('cursor', types.number);

            body.store16le('dst', cursor, 0xabcd);
            body.writeState('cursor', body.add(cursor, 2));
            body.elapse(STEP);
          });
          input.markBatchLoop?.({
            pc: input.pc,
            fill16: { memory: 'dst', stepPs: STEP, summarize: 'summarize' },
          });
          return block.finish();
        },
        configure(builder) {
          const record = builder.record({
            name: 'Fill',
            fields: { byteOffset: types.number, rounds: types.number, value: types.number },
          });
          builder.pureFn(
            {
              name: 'summarize',
              params: [{ name: 'window', type: types.number }],
              returns: types.optional(record),
            },
            (body) =>
              body.returnValue(
                body.optional(
                  body.record(record, {
                    byteOffset: 0,
                    rounds: 10_000,
                    value: 0xabcd,
                  }),
                ),
              ),
          );
        },
      },
      95,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(enabledHarness.jit.direct?.session.has(0)).toBe(true);
      expect(directJitStats(enabledHarness.jit)?.directGenericInstructions).toBe(0);
      expect(readJitBatchStats(enabledHarness.jit)).toMatchObject({ attempts: 10, commits: 0 });
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it.each(['valid', 'too-many-rounds', 'observed'] as const)(
    'uses the original loop at exact time cuts with a %s fill summary',
    (kind) => {
      const limit = 16;
      const options: Omit<HarnessOptions, 'batch'> = {
        translate(input, block) {
          if (input.pc !== 0) {
            block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
            return block.finish();
          }
          block.instruction({ pc: 0, nextPc: 1 }, (body) => {
            const cursor = body.readState('cursor', types.number);
            body.if(body.lessThan(cursor, limit), (step) => {
              step.writeState('busy', 1);
              step.store16le('dst', cursor, 0xabcd);
              step.writeState('cursor', step.add(cursor, 2));
              step.writeState('busy', 2);
              step.redirect(step.constant(types.number, 0), step.constant(types.number, STEP));
            });
          });
          input.markBatchLoop?.({
            pc: 0,
            fill16: {
              memory: 'dst',
              stepPs: STEP,
              summarize: 'summarize',
              transientWrites: ['busy'],
            },
          });
          return block.finish();
        },
        configure(builder) {
          const record = builder.record({
            name: 'Fill',
            fields: {
              byteOffset: types.number,
              rounds: types.number,
              value: types.number,
              cursor: types.number,
            },
          });
          builder.pureFn(
            {
              name: 'summarize',
              params: [{ name: 'window', type: types.number }],
              returns: types.optional(record),
            },
            (body, { window }) => {
              const cursor = body.readState('cursor', types.number);
              const rounds =
                kind === 'too-many-rounds'
                  ? body.constant(types.number, 10_000)
                  : body.min(
                      body.divide(body.subtract(limit, cursor), 2),
                      body.floor(body.divide(body.subtract(window, 1), STEP)),
                    );
              body.returnValue(
                body.optional(
                  body.record(record, {
                    byteOffset: cursor,
                    rounds,
                    value: 0xabcd,
                    cursor: body.add(cursor, body.multiply(rounds, 2)),
                  }),
                ),
              );
            },
          );
          if (kind === 'observed')
            builder.on({ name: 'watchBusy', sourcePath: ['busy'] }, () => {});
        },
      };
      const enabled = createHarness({ ...options, batch: true });
      const reference = createHarness({ ...options, batch: false });
      try {
        for (const target of [39, 40, 41, 79, 80, 81]) {
          enabled.board.runUntil(target);
          reference.board.runUntil(target);
          expect(snapshot(enabled)).toEqual(snapshot(reference));
        }
        expect(enabled.instance.states.get('busy')).toBe(2);
        const commits = readJitBatchStats(enabled.jit)?.commits ?? 0;
        if (kind === 'valid') expect(commits).toBeGreaterThan(0);
        else expect(commits).toBe(0);
      } finally {
        enabled.dispose();
        reference.dispose();
      }
    },
  );

  for (const effect of ['advance', 'fill', 'copy'] as const) {
    it(`commits ${effect} rounds once and matches per-instruction execution`, () => {
      const { enabled, reference, enabledHarness, referenceHarness } = runPair({ effect }, 2560);
      try {
        expect(enabled).toEqual(reference);
        expect(enabled.cursor).toBe(DATA_LENGTH);
        const stats = readJitBatchStats(enabledHarness.jit);
        expect(stats).toBeDefined();
        expect(stats!.commits).toBeGreaterThan(0);
        expect(stats!.foldedRounds).toBeGreaterThanOrEqual(DATA_LENGTH - 2);
        expect(readJitBatchStats(referenceHarness.jit)).toBeUndefined();
      } finally {
        enabledHarness.dispose();
        referenceHarness.dispose();
      }
    });
  }

  it('only allocates batch counters while checkpoint diagnostics are enabled', () => {
    const enabled = (globalThis as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT];
    (globalThis as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT] = {
      ...(typeof enabled === 'object' && enabled !== null ? enabled : {}),
      diagnostics: false,
    };
    const harness = createHarness({ batch: true });
    try {
      harness.board.runUntil(2560);
      expect(harness.instance.states.get('cursor')).toBe(DATA_LENGTH);
      expect(readJitBatchStats(harness.jit)).toBeUndefined();
    } finally {
      harness.dispose();
      (globalThis as Record<PropertyKey, unknown>)[CHECKPOINT_EXPERIMENT] = enabled;
    }
  });

  it('matches the reference at one step before, at, and after the batch deadline', () => {
    const enabledHarness = createHarness({ batch: true });
    const referenceHarness = createHarness({ batch: false });
    try {
      for (const target of [2549, 2550, 2551, 2560]) {
        enabledHarness.board.runUntil(target);
        referenceHarness.board.runUntil(target);
        expect(snapshot(enabledHarness), `snapshot at ${target}`).toEqual(
          snapshot(referenceHarness),
        );
      }
      const stats = readJitBatchStats(enabledHarness.jit)!;
      expect(stats.commits).toBeGreaterThan(0);
      expect(stats.foldedRounds).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('caps every batch by the CPU quantum instead of the host horizon', () => {
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { cpuQuantum: 25 },
      2560,
    );
    try {
      expect(enabled).toEqual(reference);
      const stats = readJitBatchStats(enabledHarness.jit)!;
      expect(stats.commits).toBeGreaterThan(1);
      // A 25 ps quantum and 10 ps steps can prove at most two rounds per attempt.
      expect(stats.foldedRounds).toBeLessThanOrEqual(stats.commits * 2);
      expect(stats.foldedRounds).toBeGreaterThanOrEqual(stats.commits);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('uses stopBefore only as an absolute ceiling and preserves the ordinary path afterwards', () => {
    const enabledHarness = createHarness({ effect: 'fill', batch: true, stopBefore: 'stopAt' });
    const referenceHarness = createHarness({ effect: 'fill', batch: false, stopBefore: 'stopAt' });
    try {
      enabledHarness.instance.states.set('stopAt', 1000);
      referenceHarness.instance.states.set('stopAt', 1000);
      enabledHarness.board.runUntil(1005);
      referenceHarness.board.runUntil(1005);
      expect(snapshot(enabledHarness)).toEqual(snapshot(referenceHarness));
      const stats = readJitBatchStats(enabledHarness.jit)!;
      expect(stats.commits).toBeGreaterThan(0);
      expect(stats.foldedRounds).toBe(99);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });
});

describe('JIT batch admission conflicts', () => {
  it('gives a valid same-head Direct loop precedence over a batch mark', () => {
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: 0, nextPc: 1 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, DATA_LENGTH)), (step) => {
            step.store8('dst', cursor, 42);
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 0), step.constant(types.number, STEP));
          });
        });
        input.markBatchLoop?.({ pc: 0 });
        input.markDirectLoop?.(0, { kind: 'spin' });
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { effect: 'fill', translate, directTiming: {} },
      200,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(readJitBatchStats(enabledHarness.jit)).toBeUndefined();
      expect(enabledHarness.jit.cache.get(0)?.batch).toBeUndefined();
      const direct = directJitStats(enabledHarness.jit)!;
      const baseline = directJitStats(referenceHarness.jit)!;
      expect(direct.directLoopCandidates).toBeGreaterThan(0);
      expect(direct.directLoopCandidates).toBe(baseline.directLoopCandidates);
      expect(direct.directLoopMarkRejected).toEqual(baseline.directLoopMarkRejected);
      expect(direct.directLoops).toBe(baseline.directLoops);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('rejects a Direct span starting earlier that would cover an accepted batch head', () => {
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: 0, nextPc: 1 }, (body) => {
          body.writeState(
            'prefix',
            body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
          );
          body.elapse(5);
        });
        block.instruction({ pc: 1, nextPc: 2 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, DATA_LENGTH)), (step) => {
            step.store8('dst', cursor, 42);
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 1), step.constant(types.number, STEP));
          });
        });
        block.instruction({ pc: 2, nextPc: 2 }, (body) => body.stop());
        input.markBatchLoop?.({ pc: 1 });
        // The reference board has no batch callback, so it also avoids the conflicting mark.
        if (input.markBatchLoop) input.markDirectSpan?.(0, 2);
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      {
        effect: 'fill',
        translate,
        directTiming: {},
        configure: (builder) => {
          builder.state({ name: 'prefix', type: types.number, initial: 0 });
        },
      },
      1200,
    );
    try {
      expect(enabled).toEqual(reference);
      const stats = readJitBatchStats(enabledHarness.jit)!;
      expect(stats.commits).toBeGreaterThan(0);
      expect(enabledHarness.jit.cache.get(1)?.batch).toBeDefined();
      const direct = directJitStats(enabledHarness.jit)!;
      expect(direct.directSpans).toBe(0);
      expect(direct.directSpanCandidates).toBe(0);
      expect(direct.directSpanMarkRejected.conflict).toBe(1);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('keeps a span when its only interior head loses to same-head Direct timing', () => {
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: 0, nextPc: 1 }, (body) => {
          body.writeState(
            'prefix',
            body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
          );
          body.elapse(5);
        });
        block.instruction({ pc: 1, nextPc: 2 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, DATA_LENGTH)), (step) => {
            step.store8('dst', cursor, 42);
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 1), step.constant(types.number, STEP));
          });
        });
        block.instruction({ pc: 2, nextPc: 2 }, (body) => body.stop());
        input.markBatchLoop?.({ pc: 1 });
        input.markDirectSpan?.(0, 2);
        input.markDirectSpan?.(1, 2);
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      {
        effect: 'fill',
        translate,
        directTiming: {},
        configure: (builder) => {
          builder.state({ name: 'prefix', type: types.number, initial: 0 });
        },
      },
      1200,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(readJitBatchStats(enabledHarness.jit)).toBeUndefined();
      expect(enabledHarness.jit.cache.get(1)?.batch).toBeUndefined();
      const direct = directJitStats(enabledHarness.jit)!;
      const baseline = directJitStats(referenceHarness.jit)!;
      expect(direct.directSpanCandidates).toBe(2);
      expect(direct.directSpanCandidates).toBe(baseline.directSpanCandidates);
      expect(direct.directSpanMarkRejected.conflict).toBe(0);
      expect(direct.directSpanMarkRejected).toEqual(baseline.directSpanMarkRejected);
      expect(direct.directSpans).toBe(baseline.directSpans);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('hands a batch head reached from a Direct prefix back to runJit', () => {
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: 0, nextPc: 1 }, (body) => {
          body.writeState(
            'prefix',
            body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
          );
          body.elapse(5);
        });
        block.instruction({ pc: 1, nextPc: 2 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, DATA_LENGTH)), (step) => {
            step.store8('dst', cursor, 42);
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 1), step.constant(types.number, STEP));
          });
        });
        block.instruction({ pc: 2, nextPc: 2 }, (body) => body.stop());
        input.markBatchLoop?.({ pc: 1 });
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      {
        effect: 'fill',
        translate,
        configure: (builder) => {
          builder.state({ name: 'prefix', type: types.number, initial: 0 });
        },
      },
      1200,
    );
    try {
      expect(enabled).toEqual(reference);
      const stats = readJitBatchStats(enabledHarness.jit)!;
      expect(stats.commits).toBeGreaterThan(0);
      expect(enabledHarness.jit.direct?.session.has(1) ?? false).toBe(false);
      expect(enabledHarness.instance.states.get('prefix')).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('serves a JIT PC observer and resumes folding after its slot subscriber is removed', () => {
    const observePc = (builder: DeviceBuilder) => {
      builder.state({ name: 'pcObserverRuns', type: types.number, initial: 0 });
      builder.on({ name: 'watchPc', sourcePath: ['pc'] }, (body) => {
        body.writeState(
          'pcObserverRuns',
          body.add(body.readState('pcObserverRuns', types.number), body.constant(types.number, 1)),
        );
      });
    };
    // A plain entry changes PC once before the marked loop head. The change is visible at
    // the publication boundary even though the loop head rewrites itself every round.
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: 0, nextPc: 2 }, (body) => body.elapse(5));
        block.instruction({ pc: 2, nextPc: 3 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, DATA_LENGTH)), (step) => {
            step.store8('dst', cursor, 42);
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 2), step.constant(types.number, STEP));
          });
        });
        block.instruction({ pc: 3, nextPc: 3 }, (body) => body.stop());
        input.markBatchLoop?.({ pc: 2 });
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const observedOn = createHarness({
      batch: true,
      effect: 'fill',
      translate,
      configure: observePc,
    });
    const observedOff = createHarness({
      batch: false,
      effect: 'fill',
      translate,
      configure: observePc,
    });
    const control = createHarness({ batch: true, effect: 'fill', translate });
    try {
      observedOn.board.runUntil(500);
      observedOff.board.runUntil(500);
      expect(snapshot(observedOn)).toEqual(snapshot(observedOff));
      const observedWrites = observedOn.instance.states.get('pcObserverRuns') as number;
      expect(observedWrites).toBeGreaterThan(0);
      expect(observedWrites).toBe(observedOff.instance.states.get('pcObserverRuns'));
      // The live PC subscriber declines every fold before any commit.
      const blocked = readJitBatchStats(observedOn.jit)!;
      const commitsBefore = blocked.commits;
      expect(commitsBefore).toBe(0);
      expect(blocked.declines).toBeGreaterThan(0);

      const pcSlot = observedOn.instance.stateResources.get('pc')!;
      expect(pcSlot.subscribers.size).toBeGreaterThan(0);
      for (const subscriber of [...pcSlot.subscribers]) pcSlot.subscribers.delete(subscriber);
      observedOn.instance.observerRevision++;

      observedOn.board.runUntil(2560);
      observedOff.board.runUntil(2560);
      control.board.runUntil(2560);
      expect(snapshot(observedOn)).toEqual(snapshot(control));
      expect(snapshot(observedOff)).toEqual(snapshot(control));
      expect(readJitBatchStats(observedOn.jit)!.commits).toBeGreaterThan(commitsBefore);
      expect(readJitBatchStats(control.jit)!.commits).toBeGreaterThan(0);
    } finally {
      observedOn.dispose();
      observedOff.dispose();
      control.dispose();
    }
  });

  it('does not accumulate Direct promotions for folded batch rounds', () => {
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { directTier: { promoteAfter: 1 } },
      2500,
    );
    try {
      expect(enabled).toEqual(reference);
      const stats = readJitBatchStats(enabledHarness.jit)!;
      expect(stats.commits).toBeGreaterThan(0);
      expect(enabledHarness.jit.promotions.get(0)).toBeUndefined();
      expect(directJitStats(enabledHarness.jit)!.directPromotions).toBe(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });
});

describe('JIT batch translation invalidation', () => {
  it('re-proves after code replacement and never reuses the old batch route', () => {
    const versions: number[] = [];
    const translate: JitTranslate = (input, block) => {
      versions.push(input.code[0] ?? 0);
      return effectTranslate('advance', DATA_LENGTH)(input, block);
    };
    const enabledHarness = createHarness({ batch: true, translate });
    const referenceHarness = createHarness({ batch: false, translate });
    try {
      enabledHarness.board.runUntil(1000);
      referenceHarness.board.runUntil(1000);
      const before = readJitBatchStats(enabledHarness.jit)!;
      const commitsBefore = before.commits;
      expect(commitsBefore).toBeGreaterThan(0);

      enabledHarness.instance.loadBytes('code', new Uint8Array([2]), 0);
      referenceHarness.instance.loadBytes('code', new Uint8Array([2]), 0);
      enabledHarness.board.runUntil(2560);
      referenceHarness.board.runUntil(2560);

      expect(snapshot(enabledHarness)).toEqual(snapshot(referenceHarness));
      expect(versions).toContain(2);
      const after = readJitBatchStats(enabledHarness.jit)!;
      expect(after.commits).toBeGreaterThan(commitsBefore);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('keeps a canonical -0 redirect head while dispatching through +0', () => {
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: -0, nextPc: 1 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, 64)), (step) => {
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, -0), step.constant(types.number, STEP));
          });
        });
        input.markBatchLoop?.({ pc: -0 });
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const enabledHarness = createHarness({ batch: true, translate });
    const referenceHarness = createHarness({ batch: false, translate });
    try {
      enabledHarness.board.runUntil(180);
      referenceHarness.board.runUntil(180);
      expect(Object.is(enabledHarness.instance.states.get('pc'), -0)).toBe(true);
      expect(Object.is(referenceHarness.instance.states.get('pc'), -0)).toBe(true);
      expect(enabledHarness.instance.states.get('cursor')).toBe(
        referenceHarness.instance.states.get('cursor'),
      );
      expect(enabledHarness.board.time).toBe(referenceHarness.board.time);
      expect(readJitBatchStats(enabledHarness.jit)!.commits).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('accepts a finite fractional PC that lies inside a bound code region', () => {
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0.5) {
        block.instruction({ pc: 0.5, nextPc: 1 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, 64)), (step) => {
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 0.5), step.constant(types.number, STEP));
          });
        });
        input.markBatchLoop?.({ pc: 0.5 });
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const enabledHarness = createHarness({ batch: true, translate, pcInitial: 0.5 });
    const referenceHarness = createHarness({ batch: false, translate, pcInitial: 0.5 });
    try {
      enabledHarness.board.runUntil(180);
      referenceHarness.board.runUntil(180);
      expect(enabledHarness.instance.states.get('pc')).toBe(0.5);
      expect(referenceHarness.instance.states.get('pc')).toBe(0.5);
      expect(enabledHarness.instance.states.get('cursor')).toBe(
        referenceHarness.instance.states.get('cursor'),
      );
      expect(enabledHarness.board.time).toBe(referenceHarness.board.time);
      expect(readJitBatchStats(enabledHarness.jit)!.commits).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('drops malformed, duplicated, and unbound marks without failing valid IR', () => {
    const malformed: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: 0, nextPc: 1 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, 32)), (step) => {
            step.store8('dst', cursor, 7);
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 0), step.constant(types.number, STEP));
          });
        });
        const mark = input.markBatchLoop;
        if (mark) {
          mark('bad' as never);
          mark({ pc: Number.NaN } as never);
          mark({ pc: -1 } as never);
          mark({ pc: 1.5 } as never);
          mark({ pc: 99 } as never);
          mark({ pc: 0, stopBefore: 3 } as never);
          mark({ pc: 0, stopBefore: '' } as never);
          mark({ pc: 0, stopBefore: 'missing' } as never);
          mark({ pc: 0, extra: true } as never);
          mark({ pc: 0 });
          mark({ pc: 0 });
        }
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { effect: 'fill', translate: malformed },
      320,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(readJitBatchStats(enabledHarness.jit)).toBeUndefined();
      expect(enabled.cursor).toBe(32);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('lets a malformed same-PC mark cancel a valid duplicate', () => {
    const translate: JitTranslate = (input, block) => {
      if (input.pc === 0) {
        block.instruction({ pc: 0, nextPc: 1 }, (body) => {
          const cursor = body.readState('cursor', types.number);
          body.if(body.lessThan(cursor, body.constant(types.number, 32)), (step) => {
            step.store8('dst', cursor, 7);
            step.writeState('cursor', step.add(cursor, step.constant(types.number, 1)));
            step.redirect(step.constant(types.number, 0), step.constant(types.number, STEP));
          });
        });
        const mark = input.markBatchLoop;
        if (mark) {
          mark({ pc: 0, stopBefore: 3 } as never);
          mark({ pc: 0 });
        }
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { effect: 'fill', translate },
      320,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(enabled.cursor).toBe(32);
      expect(readJitBatchStats(enabledHarness.jit)).toBeUndefined();
      expect(enabledHarness.jit.cache.get(0)?.batch).toBeUndefined();
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });
});

describe('JIT batch falls back for conflicting execution modes', () => {
  const hook = {
    configure: (builder: DeviceBuilder) => {
      builder.state({ name: 'hookFlag', type: types.bool, initial: true });
      builder.state({ name: 'hookRuns', type: types.number, initial: 0 });
      builder.fn({ name: 'hook', params: [] }, (body) => {
        body.writeState(
          'hookRuns',
          body.add(body.readState('hookRuns', types.number), body.constant(types.number, 1)),
        );
      });
    },
    beforeInstruction: { when: 'hookFlag', call: 'hook' },
  } as const;

  it('keeps instruction hooks on the ordinary path', () => {
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(hook, 100);
    try {
      expect(enabled).toEqual(reference);
      expect(readJitBatchStats(enabledHarness.jit)).toBeUndefined();
      expect(enabledHarness.instance.states.get('hookRuns')).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('admits batch heads with current dynamic code metadata', () => {
    const provider = (): JitCodeMetadata => ({ polling: [], delays: new Map() });
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { codeMetadata: provider },
      200,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(readJitBatchStats(enabledHarness.jit)!.commits).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('admits a virtual service head from the primary generation while its hook stays quiet', () => {
    const servicePc = 64;
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      {
        pcInitial: servicePc,
        codeMetadata: () => ({ polling: [], delays: new Map() }),
        beforeInstruction: { when: 'servicePending', call: 'service' },
        configure(builder) {
          builder.state({ name: 'servicePending', type: types.bool, initial: false });
          builder.fn({ name: 'service', params: [] }, (body) => {
            body.writeState('servicePending', false);
          });
        },
        translate(input, block) {
          if (input.pc === servicePc) {
            input.markBatchLoop?.({ pc: servicePc });
            block.instruction({ pc: servicePc, nextPc: servicePc + 1 }, (body) => {
              const cursor = body.readState('cursor', types.number);
              body.if(body.lessThan(cursor, 32), (step) => {
                step.writeState('cursor', step.add(cursor, 1));
                step.redirect(servicePc, STEP);
              });
            });
          } else {
            block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
          }
          return block.finish();
        },
      },
      321,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(enabled.cursor).toBe(32);
      expect(readJitBatchStats(enabledHarness.jit)!.commits).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }
  });

  it('keeps declared polling and busy-wait heads on the ordinary path', () => {
    const polling = runPair(
      {
        polling: [{ pc: 0, predicate: 'always' }],
        configure: (builder) => {
          builder.pureFn({ name: 'always', params: [], returns: types.bool }, (body) =>
            body.returnValue(body.constant(types.bool, true)),
          );
        },
      },
      100,
    );
    try {
      expect(polling.enabled).toEqual(polling.reference);
      expect(readJitBatchStats(polling.enabledHarness.jit)).toBeUndefined();
      expect(polling.enabledHarness.jit.cache.get(0)?.batch).toBeUndefined();
    } finally {
      polling.enabledHarness.dispose();
      polling.referenceHarness.dispose();
    }

    const busy = runPair({ delays: new Map([[0, { counter: 'busy', cycles: STEP }]]) }, 100);
    try {
      expect(busy.enabled).toEqual(busy.reference);
      expect(readJitBatchStats(busy.enabledHarness.jit)).toBeUndefined();
      expect(busy.enabledHarness.jit.cache.get(0)?.batch).toBeUndefined();
    } finally {
      busy.enabledHarness.dispose();
      busy.referenceHarness.dispose();
    }
  });

  it('disables batching in precise mode while shared Direct artifacts still admit marked heads', () => {
    const precise = runPair({ execution: 'precise' }, 100);
    try {
      expect(precise.enabled).toEqual(precise.reference);
      expect(readJitBatchStats(precise.enabledHarness.jit)).toBeUndefined();
    } finally {
      precise.enabledHarness.dispose();
      precise.referenceHarness.dispose();
    }

    const shared = runPair({ shareDirectArtifacts: true, shareDirectBodies: true }, 2560);
    try {
      expect(shared.enabled).toEqual(shared.reference);
      expect(readJitBatchStats(shared.enabledHarness.jit)!.commits).toBeGreaterThan(0);
    } finally {
      shared.enabledHarness.dispose();
      shared.referenceHarness.dispose();
    }
  });
});
