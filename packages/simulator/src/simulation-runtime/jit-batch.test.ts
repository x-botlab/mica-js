import { createDeviceBuilder, types, type DeviceBuilder } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
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
  builder.state({ name: 'pc', type: types.number, initial: 0 });
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
  it('keeps a marked head and every span covering it out of Direct', () => {
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
        block.instruction({ pc: 1, nextPc: 1 }, (body) => body.stop());
        input.markBatchLoop?.({ pc: 0 });
        input.markDirectSpan?.(0, 2);
      } else {
        block.instruction({ pc: input.pc, nextPc: input.pc }, (body) => body.stop());
      }
      return block.finish();
    };
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { effect: 'fill', translate, directTiming: {} },
      2560,
    );
    try {
      expect(enabled).toEqual(reference);
      const stats = readJitBatchStats(enabledHarness.jit)!;
      expect(stats.commits).toBeGreaterThan(0);
      const direct = directJitStats(enabledHarness.jit)!;
      expect(direct.directSpans).toBe(0);
      expect(direct.directSpanMarkRejected.notAdmitted).toBeGreaterThan(0);
    } finally {
      enabledHarness.dispose();
      referenceHarness.dispose();
    }

    const loopOnly: JitTranslate = (input, block) => {
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
    const loopPair = runPair({ effect: 'fill', translate: loopOnly, directTiming: {} }, 2560);
    try {
      expect(loopPair.enabled).toEqual(loopPair.reference);
      expect(readJitBatchStats(loopPair.enabledHarness.jit)!.commits).toBeGreaterThan(0);
      const direct = directJitStats(loopPair.enabledHarness.jit)!;
      expect(direct.directLoops).toBe(0);
      expect(direct.directLoopMarkRejected.notAdmitted).toBeGreaterThan(0);
    } finally {
      loopPair.enabledHarness.dispose();
      loopPair.referenceHarness.dispose();
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

  it('keeps code metadata providers on the ordinary path', () => {
    const provider = (): JitCodeMetadata => ({ polling: [], delays: new Map() });
    const { enabled, reference, enabledHarness, referenceHarness } = runPair(
      { codeMetadata: provider },
      200,
    );
    try {
      expect(enabled).toEqual(reference);
      expect(readJitBatchStats(enabledHarness.jit)).toBeUndefined();
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
    } finally {
      polling.enabledHarness.dispose();
      polling.referenceHarness.dispose();
    }

    const busy = runPair({ delays: new Map([[0, { counter: 'busy', cycles: STEP }]]) }, 100);
    try {
      expect(busy.enabled).toEqual(busy.reference);
      expect(readJitBatchStats(busy.enabledHarness.jit)).toBeUndefined();
    } finally {
      busy.enabledHarness.dispose();
      busy.referenceHarness.dispose();
    }
  });

  it('disables the feature in precise mode and with shared Direct artifacts', () => {
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
