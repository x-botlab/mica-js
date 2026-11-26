import { createDeviceBuilder, types, type BlockIR } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { BoardOptions, JitOptions, JitTranslate, SimulationError } from '../types';

interface HarnessOptions {
  readonly name?: string;
  readonly translate: JitTranslate;
  readonly directTier?: JitOptions['directTier'];
  readonly polling?: JitOptions['polling'];
  readonly execution?: BoardOptions['execution'];
  readonly configure?: (builder: ReturnType<typeof createDeviceBuilder>) => void;
  readonly load?: Uint8Array;
}

interface Harness {
  readonly board: ReturnType<typeof createBoard>;
  readonly instance: Instance;
  readonly jit: Jit;
  readonly dispose: () => void;
}

function createHarness(options: HarnessOptions): Harness {
  const name = options.name ?? 'DirectTier';
  const builder = createDeviceBuilder({ name });
  builder.memory({ name: 'code', length: 16 });
  builder.memory({ name: 'sram', length: 8 });
  for (const state of ['pc', 'steps', 'prefix', 'suffix', 'calls', 'next', 'flag'])
    builder.state({ name: state, type: types.number, initial: 0 });
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
          ...(options.directTier === undefined ? {} : { directTier: options.directTier }),
          ...(options.polling === undefined ? {} : { polling: options.polling }),
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

/** Advance one simulated step at a time until the deterministic condition holds. */
function advanceWhile(
  board: ReturnType<typeof createBoard>,
  predicate: () => boolean,
  limit = 100,
): void {
  for (let attempt = 0; attempt < limit && !predicate(); attempt++) board.runUntil(board.time + 1);
  expect(predicate()).toBe(true);
}

/** One instruction per PC; the body advances the cycle counter and consumes one ps. */
const cycleTranslate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: (pc + 1) % 3 }, (body) => {
    body.writeState(
      'steps',
      body.add(body.readState('steps', types.number), body.constant(types.number, 1)),
    );
    body.elapse(1);
  });
  return block.finish();
};

/** One self-looping instruction; PC stays put so a single route promotion is observable. */
function selfTranslate(pc = 0): JitTranslate {
  return (_input, block) => {
    block.instruction({ pc, nextPc: pc }, (body) => {
      body.writeState(
        'steps',
        body.add(body.readState('steps', types.number), body.constant(types.number, 1)),
      );
      body.elapse(1);
    });
    return block.finish();
  };
}

describe('two-tier Direct promotion', () => {
  it('promotes each PC after promoteAfter generic completions and stays equivalent to Direct', () => {
    const tier = createHarness({
      name: 'Tiered',
      translate: cycleTranslate,
      directTier: { promoteAfter: 3 },
    });
    const immediate = createHarness({
      name: 'Immediate',
      translate: cycleTranslate,
    });
    try {
      tier.board.runUntil(20);
      immediate.board.runUntil(20);
      expect(tier.instance.states.get('steps')).toBe(20);
      expect(tier.instance.states.get('steps')).toBe(immediate.instance.states.get('steps'));
      expect(tier.instance.states.get('pc')).toBe(immediate.instance.states.get('pc'));
      expect(tier.board.time).toBe(immediate.board.time);

      const stats = directJitStats(tier.jit)!;
      expect(stats.directPromotionGenericRuns).toBe(9);
      expect(stats.directPromotions).toBe(3);
      expect(stats.directTierFallbacks).toBe(6);
      expect(stats.directCompiles).toBe(1);
      expect(stats.directSessions).toBe(1);
      expect(stats.directRoutes).toBe(3);
      expect(stats.directPromotedRoutes).toBe(3);
      expect(tier.jit.promotions.size).toBe(3);
      for (const [pc, promotion] of tier.jit.promotions) {
        expect(promotion.state, `pc ${pc}`).toBe('promoted');
        expect(promotion.count, `pc ${pc}`).toBe(3);
        expect(tier.jit.direct!.session.has(pc)).toBe(true);
      }

      const reference = directJitStats(immediate.jit)!;
      expect(reference.directPromotionGenericRuns).toBe(0);
      expect(reference.directPromotions).toBe(0);
      expect(reference.directTierFallbacks).toBe(0);
      expect(reference.directRoutes).toBe(3);
    } finally {
      immediate.dispose();
      tier.dispose();
    }
  });

  it('adds only the newly promoted route to an existing session', () => {
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: pc }, (body) => {
        body.writeState(
          'steps',
          body.add(body.readState('steps', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const harness = createHarness({
      name: 'Independent',
      translate,
      directTier: { promoteAfter: 2 },
    });
    try {
      advanceWhile(harness.board, () => directJitStats(harness.jit)?.directPromotions === 1);
      advanceWhile(harness.board, () => harness.jit.direct?.session.has(0) === true);
      let stats = directJitStats(harness.jit)!;
      expect(stats.directSessions).toBe(1);
      expect(stats.directCompiles).toBe(1);
      expect(stats.directRoutes).toBe(1);
      expect(stats.directPromotedRoutes).toBe(1);
      expect(harness.jit.direct!.session.has(0)).toBe(true);
      expect(harness.jit.direct!.session.has(1)).toBe(false);

      harness.instance.states.set('pc', 1);
      advanceWhile(harness.board, () => directJitStats(harness.jit)?.directPromotions === 2);
      stats = directJitStats(harness.jit)!;
      expect(stats.directSessions).toBe(1);
      expect(stats.directCompiles).toBe(1);

      advanceWhile(harness.board, () => harness.jit.direct?.session.has(1) === true);
      stats = directJitStats(harness.jit)!;
      expect(stats.directSessions).toBe(1);
      expect(stats.directCompiles).toBe(1);
      expect(stats.directRoutes).toBe(2);
      expect(stats.directPromotedRoutes).toBe(2);
      expect(harness.jit.direct!.session.has(0)).toBe(true);
      expect(harness.jit.direct!.session.has(1)).toBe(true);
      expect(harness.instance.states.get('steps')).toBeGreaterThan(0);
    } finally {
      harness.dispose();
    }
  });

  it('counts a suspended instruction once, after its final suffix', () => {
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: 0 }, (body) => {
        body.writeState(
          'prefix',
          body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
        body.writeState(
          'suffix',
          body.add(body.readState('suffix', types.number), body.constant(types.number, 1)),
        );
      });
      return block.finish();
    };
    const harness = createHarness({
      name: 'Split',
      translate,
      directTier: { promoteAfter: 100 },
    });
    try {
      harness.board.runUntil(3);
      expect(harness.instance.states.get('prefix')).toBeGreaterThanOrEqual(2);
      expect(harness.instance.states.get('suffix')).toBe(2);
      const stats = directJitStats(harness.jit)!;
      // Two logical instructions, each split into a prefix and a suffix.
      expect(stats.directPromotionGenericRuns).toBe(2);
      expect(harness.jit.promotions.get(0)?.count).toBe(2);
      expect(stats.directPromotions).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it('does not count explicit or automatic polling turns', () => {
    const explicit = createHarness({
      name: 'ExplicitPolling',
      translate: selfTranslate(),
      directTier: { promoteAfter: 1 },
      polling: [{ pc: 0, predicate: 'awake' }],
      configure: (builder) => {
        builder.pureFn({ name: 'awake', params: [], returns: types.bool }, (body) => {
          body.returnValue(body.constant(types.bool, true));
        });
      },
    });
    const automatic = createHarness({
      name: 'AutomaticPolling',
      translate: (_input, block) => {
        block.instruction({ pc: 0, nextPc: 0 }, (body) => {
          const target = body.add(
            body.readState('next', types.number),
            body.constant(types.number, 0),
          );
          body.redirect(target, body.constant(types.number, 1));
        });
        return block.finish();
      },
      directTier: { promoteAfter: 1 },
    });
    try {
      explicit.board.runUntil(3);
      const explicitStats = directJitStats(explicit.jit)!;
      expect(explicit.instance.states.get('steps')).toBe(3);
      expect(explicitStats.directPromotionGenericRuns).toBe(0);
      expect(explicitStats.directTierFallbacks).toBe(0);
      expect(explicitStats.directSessions).toBe(0);
      expect(explicit.jit.promotions.size).toBe(0);

      automatic.board.runUntil(2);
      const automaticStats = directJitStats(automatic.jit)!;
      expect(automatic.jit.cache.get(0)?.polling).toBe(true);
      expect(automaticStats.directPromotionGenericRuns).toBe(0);
      expect(automaticStats.directTierFallbacks).toBe(0);
      expect(automaticStats.directSessions).toBe(0);
      expect(automatic.jit.promotions.size).toBe(0);
    } finally {
      automatic.dispose();
      explicit.dispose();
    }
  });

  it('does not count a stale suspended suffix or a failed instruction', () => {
    const split: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: 0 }, (body) => {
        body.writeState(
          'prefix',
          body.add(body.readState('prefix', types.number), body.constant(types.number, 1)),
        );
        body.elapse(10);
        body.writeState(
          'suffix',
          body.add(body.readState('suffix', types.number), body.constant(types.number, 1)),
        );
      });
      return block.finish();
    };
    const stale = createHarness({
      name: 'StaleSuffix',
      translate: split,
      directTier: { promoteAfter: 1 },
    });
    try {
      stale.board.runUntil(1);
      expect(stale.instance.states.get('prefix')).toBe(1);
      expect(stale.instance.states.get('suffix')).toBe(0);
      stale.instance.loadBytes('code', new Uint8Array([2]), 0);
      stale.board.runUntil(11);
      // The old suffix still completes once, but the replaced code version must not count.
      expect(stale.instance.states.get('suffix')).toBe(1);
      expect(directJitStats(stale.jit)!.directPromotionGenericRuns).toBe(0);
      expect(stale.jit.promotions.size).toBe(0);
    } finally {
      stale.dispose();
    }

    const failing = createHarness({
      name: 'FailedGeneric',
      translate: (_input, block) => {
        block.instruction({ pc: 0, nextPc: 0 }, (body) => {
          body.assert(
            body.equal(
              types.number,
              body.readState('flag', types.number),
              body.constant(types.number, 1),
            ),
            (message) => message.constant(types.string, 'expected flag'),
          );
          body.elapse(1);
        });
        return block.finish();
      },
      directTier: { promoteAfter: 1 },
    });
    try {
      let failure: SimulationError | undefined;
      try {
        failing.board.runUntil(1);
      } catch (cause) {
        failure = cause as SimulationError;
      }
      expect(failure).toBeDefined();
      expect(directJitStats(failing.jit)!.directPromotionGenericRuns).toBe(0);
      expect(failing.jit.promotions.size).toBe(0);
    } finally {
      failing.dispose();
    }
  });

  it('resets promotion state only for the instance or PC whose identity changed', () => {
    const libraryFor = (
      stable: { value: BlockIR | undefined },
      changed: { value: boolean },
      reuseStable: { value: boolean },
    ) => {
      const builder = createDeviceBuilder({ name: 'PromotionIdentity' });
      builder.memory({ name: 'code', length: 8 });
      for (const state of ['pc', 'first', 'second'])
        builder.state({ name: state, type: types.number, initial: 0 });
      const translate: JitTranslate = (input, block) => {
        if (reuseStable.value && stable.value !== undefined) return stable.value;
        block.instruction({ pc: 1, nextPc: 0 }, (body) => {
          body.writeState(
            'second',
            body.add(body.readState('second', types.number), body.constant(types.number, 1)),
          );
          body.elapse(1);
        });
        block.instruction({ pc: 0, nextPc: 1 }, (body) => {
          body.writeState(
            'first',
            body.add(
              body.readState('first', types.number),
              body.constant(types.number, changed.value ? 10 : 1),
            ),
          );
          body.elapse(1);
        });
        const result = block.finish();
        if (input.pc === 1 && !changed.value) stable.value = result;
        return result;
      };
      const library = createDeviceLibrary([
        {
          id: 'identity',
          model: builder.finish(),
          create: (context) => {
            const registration = context.attachJit({
              entry: 'identity',
              code: 'code',
              pc: 'pc',
              directTier: { promoteAfter: 100 },
              translate,
            });
            try {
              context.loadBytes('code', new Uint8Array([1]));
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
        { instances: [{ id: 'identity', type: 'identity' }], nets: [] },
        { execution: 'throughput' },
      );
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      return { board, instance, jit: instance.jits[0]!, dispose: () => board.dispose() };
    };

    const stable = { value: undefined as BlockIR | undefined };
    const changed = { value: false };
    const reuseStable = { value: false };
    const identical = libraryFor(stable, changed, reuseStable);
    try {
      identical.instance.states.set('pc', 1);
      advanceWhile(
        identical.board,
        () =>
          (identical.jit.promotions.get(0)?.count ?? 0) >= 1 &&
          (identical.jit.promotions.get(1)?.count ?? 0) >= 1,
      );
      expect(identical.jit.promotions.get(0)?.count).toBe(1);
      expect(identical.jit.promotions.get(1)?.count).toBe(1);
      identical.jit.cache.delete(1);
      reuseStable.value = true;
      advanceWhile(identical.board, () => identical.jit.cache.has(1));
      expect(identical.jit.promotions.get(0)?.count).toBeGreaterThanOrEqual(1);
      expect(directJitStats(identical.jit)!.directPromotionResets).toBe(0);
    } finally {
      identical.dispose();
    }

    const stable2 = { value: undefined as BlockIR | undefined };
    const changed2 = { value: false };
    const reuseStable2 = { value: false };
    const replacement = libraryFor(stable2, changed2, reuseStable2);
    try {
      replacement.instance.states.set('pc', 1);
      advanceWhile(
        replacement.board,
        () =>
          (replacement.jit.promotions.get(0)?.count ?? 0) >= 1 &&
          (replacement.jit.promotions.get(1)?.count ?? 0) >= 1,
      );
      expect(replacement.jit.promotions.get(0)?.count).toBe(1);
      expect(replacement.jit.promotions.get(1)?.count).toBe(1);
      replacement.jit.cache.delete(1);
      changed2.value = true;
      advanceWhile(
        replacement.board,
        () => (directJitStats(replacement.jit)?.directPromotionResets ?? 0) === 1,
      );
      const stats = directJitStats(replacement.jit)!;
      expect(stats.directPromotionResets).toBe(1);
      // Only PC 0's identity changed; a fresh completion of its new body may start a new
      // count, but the old count must not survive.
      expect(replacement.jit.promotions.get(0)?.count ?? 0).toBeLessThanOrEqual(1);
      expect(replacement.jit.promotions.get(1)?.count).toBeGreaterThanOrEqual(1);
    } finally {
      replacement.dispose();
    }
  });

  it('handles promoteAfter boundaries and keeps the counter saturated at the threshold', () => {
    const immediate = createHarness({
      name: 'PromoteOne',
      translate: selfTranslate(),
      directTier: { promoteAfter: 1 },
    });
    try {
      advanceWhile(
        immediate.board,
        () => (directJitStats(immediate.jit)?.directPromotionGenericRuns ?? 0) === 1,
      );
      const first = directJitStats(immediate.jit)!;
      expect(first.directPromotionGenericRuns).toBe(1);
      expect(first.directPromotions).toBe(1);
      expect(immediate.jit.promotions.get(0)).toMatchObject({ state: 'promoted', count: 1 });
      advanceWhile(immediate.board, () => immediate.jit.direct?.session.has(0) === true);
      const second = directJitStats(immediate.jit)!;
      expect(second.directSessions).toBe(1);
      expect(second.directRoutes).toBe(1);
      expect(second.directPromotedRoutes).toBe(1);
    } finally {
      immediate.dispose();
    }

    const late = createHarness({
      name: 'PromoteThirtyTwo',
      translate: selfTranslate(),
      directTier: { promoteAfter: 32 },
    });
    try {
      advanceWhile(
        late.board,
        () => (directJitStats(late.jit)?.directPromotionGenericRuns ?? 0) === 31,
      );
      let stats = directJitStats(late.jit)!;
      expect(stats.directPromotionGenericRuns).toBe(31);
      expect(stats.directPromotions).toBe(0);
      expect(late.jit.promotions.get(0)).toMatchObject({ state: 'generic', count: 31 });
      advanceWhile(
        late.board,
        () => (directJitStats(late.jit)?.directPromotionGenericRuns ?? 0) === 32,
      );
      stats = directJitStats(late.jit)!;
      expect(stats.directPromotionGenericRuns).toBe(32);
      expect(stats.directPromotions).toBe(1);
      expect(late.jit.promotions.get(0)).toMatchObject({ state: 'promoted', count: 32 });
      advanceWhile(late.board, () => late.jit.direct?.session.has(0) === true);
      for (let index = 0; index < 8; index++) late.board.runUntil(late.board.time + 1);
      stats = directJitStats(late.jit)!;
      expect(stats.directSessions).toBe(1);
      expect(stats.directRoutes).toBe(1);
      expect(stats.directPromotedRoutes).toBe(1);
      expect(stats.directPromotionGenericRuns).toBe(32);
      expect(late.jit.promotions.get(0)?.count).toBe(32);
    } finally {
      late.dispose();
    }
  });

  it('keeps the omitted tier on the immediate-Direct path and ignores promotion in precise', () => {
    const immediate = createHarness({ name: 'DefaultImmediate', translate: cycleTranslate });
    try {
      advanceWhile(immediate.board, () => immediate.jit.direct?.session.has(0) === true);
      const stats = directJitStats(immediate.jit)!;
      expect(immediate.jit.direct?.session.has(0)).toBe(true);
      expect(stats.directPromotionGenericRuns).toBe(0);
      expect(stats.directPromotions).toBe(0);
      expect(stats.directTierFallbacks).toBe(0);
      expect(stats.directPromotedRoutes).toBe(0);
      expect(stats.directPromotionResets).toBe(0);
      expect(immediate.jit.promotions.size).toBe(0);
      immediate.board.runUntil(10);
      expect(immediate.instance.states.get('steps')).toBeGreaterThan(0);
    } finally {
      immediate.dispose();
    }

    const precise = createHarness({
      name: 'PreciseTier',
      translate: selfTranslate(),
      directTier: { promoteAfter: 1 },
      execution: 'precise',
    });
    try {
      precise.board.runUntil(3);
      expect(precise.instance.states.get('steps')).toBe(3);
      expect(precise.jit.direct).toBeUndefined();
      expect(precise.jit.promotions.size).toBe(0);
      const stats = directJitStats(precise.jit);
      expect(stats?.directPromotionGenericRuns ?? 0).toBe(0);
      expect(stats?.directPromotions ?? 0).toBe(0);
    } finally {
      precise.dispose();
    }
  });

  it('leaves a statically rejected promoted PC on the generic path', () => {
    const translate: JitTranslate = (_input, block) => {
      block.instruction({ pc: 0, nextPc: 0 }, (body) => {
        body.call('bump');
        body.elapse(1);
      });
      return block.finish();
    };
    const harness = createHarness({
      name: 'RejectedDirect',
      translate,
      directTier: { promoteAfter: 1 },
      configure: (builder) => {
        builder.fn({ name: 'bump', params: [] }, (body) => {
          body.writeState(
            'calls',
            body.add(body.readState('calls', types.number), body.constant(types.number, 1)),
          );
        });
      },
    });
    try {
      harness.board.runUntil(5);
      const stats = directJitStats(harness.jit)!;
      // The base-model function is valid IR for the interpreter but not in the Direct
      // binding's function table, so the promoted entry is rejected once and stays generic.
      expect(harness.instance.states.get('calls')).toBe(5);
      expect(harness.board.status).toBe('ready');
      expect(stats.directPromotions).toBe(1);
      expect(stats.directPromotionGenericRuns).toBe(1);
      expect(stats.directSessions).toBe(1);
      expect(stats.directRoutes).toBe(0);
      expect(stats.directPromotedRoutes).toBe(0);
      expect(stats.directFallbacks).toBeGreaterThanOrEqual(1);
      expect(harness.jit.promotions.get(0)).toMatchObject({ state: 'promoted', count: 1 });
      expect(stats.directPromotions).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it('clears one instance after a primary code write and leaves another instance untouched', () => {
    const builder = createDeviceBuilder({ name: 'TwoBoards' });
    builder.memory({ name: 'code', length: 8 });
    for (const state of ['pc', 'steps'])
      builder.state({ name: state, type: types.number, initial: 0 });
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: pc }, (body) => {
        body.writeState(
          'steps',
          body.add(body.readState('steps', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'two-boards',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'two-boards',
            code: 'code',
            pc: 'pc',
            directTier: { promoteAfter: 2 },
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array([1]));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const first = createBoard(
      library,
      { instances: [{ id: 'first', type: 'two-boards' }], nets: [] },
      { execution: 'throughput' },
    );
    const second = createBoard(
      library,
      { instances: [{ id: 'second', type: 'two-boards' }], nets: [] },
      { execution: 'throughput' },
    );
    try {
      const firstInstance = (first as unknown as { instances: readonly Instance[] }).instances[0]!;
      const secondInstance = (second as unknown as { instances: readonly Instance[] })
        .instances[0]!;
      const firstJit = firstInstance.jits[0]!;
      const secondJit = secondInstance.jits[0]!;
      advanceWhile(first, () => firstJit.direct?.session.has(0) === true);
      advanceWhile(second, () => secondJit.direct?.session.has(0) === true);
      expect(firstInstance.states.get('steps')).toBeGreaterThanOrEqual(3);
      expect(secondInstance.states.get('steps')).toBeGreaterThanOrEqual(3);
      expect(firstJit.promotions.size).toBe(1);
      expect(secondJit.promotions.size).toBe(1);
      expect(firstJit.direct!.session.has(0)).toBe(true);
      expect(secondJit.direct!.session.has(0)).toBe(true);

      firstInstance.loadBytes('code', new Uint8Array([9]), 0);
      const firstStats = directJitStats(firstJit)!;
      expect(firstJit.promotions.size).toBe(0);
      expect(firstStats.directPromotionResets).toBe(1);
      expect(firstStats.directPromotedRoutes).toBe(0);
      // A suffix already in flight keeps its old frame until it completes once; the old
      // session cannot start a new instruction and is released at that boundary.
      expect(firstJit.direct === undefined || firstJit.directStale).toBe(true);
      advanceWhile(first, () => firstJit.direct === undefined);
      expect(firstStats.directRoutes).toBe(0);
      expect(firstStats.directPromotedRoutes).toBe(0);

      const secondStats = directJitStats(secondJit)!;
      expect(secondJit.promotions.size).toBe(1);
      expect(secondStats.directPromotionResets).toBe(0);
      expect(secondStats.directRoutes).toBe(1);
      expect(secondStats.directPromotedRoutes).toBe(1);
      expect(secondJit.direct!.session.has(0)).toBe(true);
    } finally {
      second.dispose();
      first.dispose();
    }
  });
});
