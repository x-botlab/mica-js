/**
 * J14 region compilation.
 *
 * A region turns a hot dispatch chain into one JavaScript state machine:
 * cross-member dispatches become `cur = j; continue`, so a guest loop becomes
 * a plain JS loop. These tests pin formation (hottest-successor DFS), the
 * generated shape and the correctness of the generic fallback when epochs or
 * provider caches change.
 */
import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../builder';
import {
  createIRInterpreter,
  createIRModule,
  IRExecutionError,
  type IRExecutionContext,
  type IRModule,
  type IRResourcePermission,
  type IRValidationOptions,
  type RuntimeScalar,
} from '../index';
import { createIRJIT, jitInternals } from '../jit-runtime';
import type { IRJITInternals } from '../jit-runtime';
import type { Target } from '../engine-setup';
import { DispatchRegistry, providerDispatchInfo, REGION_THRESHOLD } from './dispatch-ic';
import type { ArtifactState, DispatchKey } from './dispatch-ic';
import {
  collectRegionMembers,
  collectRegionPromotions,
  createRegionExitProfile,
  recordRegionExit,
  regionKeyOf,
  REGION_DIRECT_CALL_THRESHOLD,
  REGION_PROFILE_BUDGET,
  REGION_PROFILE_SLOTS,
} from './region';
import type { RegionMember } from './region';
import { Op } from './mir';
import type { MInst, ValueId } from './mir';
import type { MemoryDefinition } from '../types';

const context: IRExecutionContext = { instanceId: 'region', virtualTime: 11 };

function policy(
  module: IRModule,
  extra: readonly IRResourcePermission[] = [],
): IRValidationOptions {
  return Object.freeze({
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: Object.freeze([
      ...module.memories.map((memory) => ({
        ref: memory.ref,
        access: memory.writable ? ('read-write' as const) : ('read' as const),
      })),
      ...extra,
    ]),
  });
}

function internals(engine: ReturnType<typeof createIRJIT>): IRJITInternals {
  return (engine as unknown as Record<symbol, IRJITInternals>)[jitInternals]!;
}

function execute(
  engine: ReturnType<typeof createIRJIT>,
  target: Target,
  args: readonly RuntimeScalar[],
): readonly RuntimeScalar[] {
  return engine.execute(target, args, context).values;
}

/* -------------------------------------------------------------------------
 * Formation
 * ---------------------------------------------------------------------- */

function fakeState(index: number, providerIndex = 0, entries = 0): ArtifactState {
  return {
    artifact: { index },
    key: [index] as readonly DispatchKey[],
    providerIndex,
    mir: { promotions: [] },
    compiled: { fn: () => index },
    dependencies: [],
    storageEpoch: 0,
    providerEpoch: 0,
    validatedEpoch: -1,
    entries,
    region: undefined,
    regionIndex: -1,
  } as unknown as ArtifactState;
}

describe('region formation', () => {
  it('walks the hottest successor first and keeps one provider', () => {
    const registry = new DispatchRegistry(providerDispatchInfo([]));
    const entry = fakeState(0);
    const hot = fakeState(1);
    const cold = fakeState(2);
    const foreign = fakeState(3, 1);
    const site = registry.site(0, entry);
    registry.record(site, hot.key, hot, 0, 0);
    registry.record(site, cold.key, cold, 0, 0);
    registry.record(site, foreign.key, foreign, 0, 0);
    site.counts[0] = 10;
    site.counts[1] = 2;
    site.counts[2] = 100;
    // Hottest first, foreign provider dropped, entry stays first.
    expect(collectRegionMembers(entry, registry)).toEqual([entry, hot, cold]);
  });

  it('follows a cycle only once and respects the member bound', () => {
    const registry = new DispatchRegistry(providerDispatchInfo([]));
    const states = Array.from({ length: 40 }, (_value, index) => fakeState(index));
    for (let index = 0; index < states.length - 1; index += 1) {
      const site = registry.site(0, states[index]!);
      registry.record(site, states[index + 1]!.key, states[index + 1]!, 0, 0);
    }
    const cycle = registry.site(0, states.at(-1)!);
    registry.record(cycle, states[0]!.key, states[0]!, 0, 0);
    const members = collectRegionMembers(states[0]!, registry);
    expect(members).toHaveLength(32);
    expect(new Set(members).size).toBe(members.length);
    expect(members[0]).toBe(states[0]);
  });
});

/* -------------------------------------------------------------------------
 * Engine fixture: a two-block guest loop
 * ---------------------------------------------------------------------- */

function guestLoopFixture() {
  const calls = { generated: 0, keys: [] as number[] };
  const module = createIRModule();
  const firmware = module.bytes('firmware', new Uint8Array([1, 2, 3, 4]), {
    readonly: true,
    unitBytes: 2,
  });
  const blocks = module.provider(
    'blocks',
    {
      keyTypes: ['u32'],
      params: ['u32'],
      results: ['u32'],
      reads: [firmware],
      imports: [],
    },
    (gen, [key]) => {
      calls.generated += 1;
      calls.keys.push(key);
      const byte = gen.readBytes(firmware, 0, 1)[0]!;
      if (key === 0) {
        return gen.function((b, [value]) => {
          const zero = b.const('u32', 0);
          const one = b.const('u32', 1);
          const next = b.block(['u32']);
          const stop = b.block(['u32']);
          b.branch(
            b.int.cmp('gt', value, zero),
            { target: next, args: [value] },
            { target: stop, args: [value] },
          );
          b.at(next, (inner, [inside]) =>
            inner.dispatch(blocks, [inner.const('u32', 0)], [inner.int.sub(inside, one)]),
          );
          b.at(stop, (inner, [inside]) =>
            inner.dispatch(blocks, [inner.const('u32', 1)], [inner.int.add(inside, one)]),
          );
        });
      }
      return gen.function((b, [value]) => b.return([b.int.add(value, b.const('u32', byte))]));
    },
  );
  const run = module.func('run', { params: ['u32'], results: ['u32'] });
  run.body((b, [n]) => b.dispatch(blocks, [b.const('u32', 0)], [n]));
  return { module, run, calls, firmware, blocks };
}

const WARM_RUNS = 70;
const LOOP_LENGTH = 10;

describe('compiled regions', () => {
  it('compiles a self-loop chain once the artifact is hot', () => {
    const { module, run, calls } = guestLoopFixture();
    const jit = createIRJIT(module, { validation: policy(module) });
    const expected = 1 + 1; // key1 returns value + firmware[0]
    for (let index = 0; index < WARM_RUNS; index += 1) {
      expect(execute(jit, run, [LOOP_LENGTH])).toEqual([expected]);
    }
    expect(calls.generated).toBe(2);
    expect(internals(jit).regions).toBe(1);
    const source = internals(jit).regionSource!;
    expect(source).toContain('switch (Rcur)');
    expect(source).toContain('continue Lregion');
    expect(source).toContain('case 0:');
    expect(source).toContain('case 1:');
    // The self dispatch is a JS loop inside case 0, not a TAIL round trip.
    expect(source).toContain('Rcur = 0');
  });

  it('keeps step counts identical to the reference before and after formation', () => {
    const jitFixture = guestLoopFixture();
    const referenceFixture = guestLoopFixture();
    const jit = createIRJIT(jitFixture.module, { validation: policy(jitFixture.module) });
    const reference = createIRInterpreter(referenceFixture.module, {
      validation: policy(referenceFixture.module),
    });
    for (let index = 0; index < WARM_RUNS; index += 1) {
      const actual = jit.execute(jitFixture.run, [LOOP_LENGTH], context);
      const expected = reference.execute(referenceFixture.run, [LOOP_LENGTH], context);
      expect({ index, values: actual.values, steps: actual.steps }).toEqual({
        index,
        values: expected.values,
        steps: expected.steps,
      });
    }
    expect(internals(jit).regions).toBe(1);
  });

  it('re-enters a member through materialize when only the epoch moved', () => {
    const { module, run, calls, firmware } = guestLoopFixture();
    const jit = createIRJIT(module, {
      validation: policy(module, [{ ref: firmware, access: 'update' as const }]),
    });
    for (let index = 0; index < WARM_RUNS; index += 1) execute(jit, run, [LOOP_LENGTH]);
    expect(internals(jit).regions).toBe(1);
    const misses = internals(jit).icMisses;

    // Unit 1 (bytes 2..3) was never read by the provider, so updating it bumps
    // the storage epoch without invalidating any dependency. The site IC
    // misses, materialize returns the cached artifacts, and the region adopts
    // the member again.
    jit.storage.updateBytesFromBytes(firmware, 2, new Uint8Array([9]));
    expect(execute(jit, run, [LOOP_LENGTH])).toEqual([2]);
    expect(internals(jit).icMisses).toBeGreaterThan(misses);
    expect(internals(jit).regions).toBe(1);
    expect(calls.generated).toBe(2);
  });

  it('leaves the region when a dependency regenerates an artifact', () => {
    const { module, run, calls, firmware } = guestLoopFixture();
    const jit = createIRJIT(module, {
      validation: policy(module, [{ ref: firmware, access: 'update' as const }]),
    });
    for (let index = 0; index < WARM_RUNS; index += 1) execute(jit, run, [LOOP_LENGTH]);
    expect(internals(jit).regions).toBe(1);
    expect(calls.generated).toBe(2);

    jit.storage.updateBytesFromBytes(firmware, 0, new Uint8Array([5]));
    // Both cached artifacts are invalid; the first post-update dispatch
    // regenerates them and the old region is no longer selectable.
    expect(execute(jit, run, [LOOP_LENGTH])).toEqual([6]);
    expect(calls.generated).toBe(4);
    expect(execute(jit, run, [LOOP_LENGTH])).toEqual([6]);
    expect(calls.generated).toBe(4);
  });

  it('promotes state resources across members and spills at the region exit', () => {
    const build = () => {
      const module = createIRModule();
      const acc = module.state('acc', 'u32', 0);
      const blocks = module.provider(
        'blocks',
        { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [], imports: [acc] },
        (gen, [key]) =>
          gen.function((b, [value]) => {
            const loaded = b.state.load(acc);
            b.state.store(acc, b.int.add(loaded, b.const('u32', 1)));
            const zero = b.const('u32', 0);
            const next = b.block(['u32']);
            const done = b.block(['u32']);
            b.branch(
              b.int.cmp('gt', value, zero),
              { target: next, args: [value] },
              { target: done, args: [value] },
            );
            b.at(next, (inner, [inside]) =>
              inner.dispatch(
                blocks,
                [inner.const('u32', key)],
                [inner.int.sub(inside, inner.const('u32', 1))],
              ),
            );
            b.at(done, (inner) => inner.return([inner.state.load(acc)]));
          }),
      );
      const run = module.func('run', { params: ['u32'], results: ['u32'] });
      run.body((b, [n]) => b.dispatch(blocks, [b.const('u32', 0)], [n]));
      return { module, run, acc };
    };
    const fixture = build();
    const jit = createIRJIT(fixture.module, { validation: policy(fixture.module), maxSteps: 1e9 });
    const reference = createIRInterpreter(fixture.module, {
      validation: policy(fixture.module),
      maxSteps: 1e9,
    });
    for (let index = 0; index < WARM_RUNS; index += 1) {
      const actual = jit.execute(fixture.run, [LOOP_LENGTH], context);
      const expected = reference.execute(fixture.run, [LOOP_LENGTH], context);
      expect({ values: actual.values, steps: actual.steps }).toEqual({
        values: expected.values,
        steps: expected.steps,
      });
    }
    expect(internals(jit).regions).toBe(1);
    expect(internals(jit).regionSource).toContain('rp0');
    expect(internals(jit).regionSource).toContain('rp0d = 1;');
    expect(jit.storage.loadState(fixture.acc)).toBe(reference.storage.loadState(fixture.acc));
  });

  it('spills promoted state before a host boundary inside a member', () => {
    const module = createIRModule();
    const acc = module.state('acc', 'u32', 0);
    const later = module.entry('later', []);
    later.body((b) => b.return([]));
    const blocks = module.provider(
      'blocks',
      {
        keyTypes: ['u32'],
        params: ['u32'],
        results: ['u32'],
        reads: [],
        imports: [acc, later],
      },
      (gen) =>
        gen.function((b, [value]) => {
          const loaded = b.state.load(acc);
          b.state.store(acc, b.int.add(loaded, b.const('u32', 1)));
          const zero = b.const('u32', 0);
          const next = b.block(['u32']);
          const done = b.block(['u32']);
          b.branch(
            b.int.cmp('gt', value, zero),
            { target: next, args: [value] },
            { target: done, args: [value] },
          );
          b.at(next, (inner, [inside]) =>
            inner.dispatch(
              blocks,
              [inner.const('u32', 0)],
              [inner.int.sub(inside, inner.const('u32', 1))],
            ),
          );
          b.at(done, (inner) => {
            inner.event.at(later, inner.const('f64', 0), []);
            inner.return([inner.state.load(acc)]);
          });
        }),
    );
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => b.dispatch(blocks, [b.const('u32', 0)], [n]));
    const observed: number[] = [];
    const engine: { current: ReturnType<typeof createIRJIT> | undefined } = { current: undefined };
    const jit = createIRJIT(module, {
      validation: policy(module),
      maxSteps: 1e9,
      eventHost: {
        now: () => 0,
        at: () => {
          observed.push(engine.current!.storage.loadState(acc));
          return 1;
        },
        cancel: () => undefined,
      },
    });
    engine.current = jit;
    for (let index = 0; index < WARM_RUNS; index += 1) jit.execute(run, [LOOP_LENGTH], context);
    expect(internals(jit).regions).toBe(1);
    // Each run increments acc LOOP_LENGTH + 1 times and the handler is called
    // after the last increment; storage must already contain that value.
    const expected = WARM_RUNS * (LOOP_LENGTH + 1);
    expect(observed.at(-1)).toBe(expected);
    expect(jit.storage.loadState(acc)).toBe(expected);
  });

  it('folds a member-local scalar promotion into the region local', () => {
    const build = () => {
      const module = createIRModule();
      const acc = module.state('acc', 'u32', 0);
      const blocks = module.provider(
        'blocks',
        { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [], imports: [acc] },
        (gen, [key]) => {
          if (key !== 0) return gen.function((b) => b.return([b.state.load(acc)]));
          return gen.function((b, [value]) => {
            // Internal CFG loop: `scalarPromotion` turns `acc` into a member
            // local (`ps0`), which the region must resolve to its own shared
            // local instead of keeping one copy per member.
            const zero = b.const('u32', 0);
            const one = b.const('u32', 1);
            const head = b.block(['u32']);
            const body = b.block(['u32']);
            const after = b.block(['u32']);
            const next = b.block(['u32']);
            const done = b.block(['u32']);
            b.jump(head, [zero]);
            b.at(head, (inner, [index]) =>
              inner.branch(
                inner.int.cmp('lt', index, one),
                { target: body, args: [index] },
                { target: after, args: [index] },
              ),
            );
            b.at(body, (inner, [index]) => {
              inner.state.store(acc, inner.int.add(inner.state.load(acc), one));
              inner.jump(head, [inner.int.add(index, one)]);
            });
            b.at(after, (inner) =>
              inner.branch(
                inner.int.cmp('gt', value, zero),
                { target: next, args: [value] },
                { target: done, args: [value] },
              ),
            );
            b.at(next, (inner, [inside]) =>
              inner.dispatch(
                blocks,
                [inner.const('u32', 0)],
                [inner.int.sub(inside, inner.const('u32', 1))],
              ),
            );
            b.at(done, (inner, [inside]) =>
              inner.dispatch(
                blocks,
                [inner.const('u32', 1)],
                [inner.int.add(inside, inner.const('u32', 1))],
              ),
            );
          });
        },
      );
      const run = module.func('run', { params: ['u32'], results: ['u32'] });
      run.body((b, [n]) => b.dispatch(blocks, [b.const('u32', 0)], [n]));
      return { module, run, acc };
    };
    const fixture = build();
    const jit = createIRJIT(fixture.module, { validation: policy(fixture.module), maxSteps: 1e9 });
    const reference = createIRInterpreter(fixture.module, {
      validation: policy(fixture.module),
      maxSteps: 1e9,
    });
    for (let index = 0; index < WARM_RUNS; index += 1) {
      const actual = jit.execute(fixture.run, [LOOP_LENGTH], context);
      const expected = reference.execute(fixture.run, [LOOP_LENGTH], context);
      expect({ values: actual.values, steps: actual.steps }).toEqual({
        values: expected.values,
        steps: expected.steps,
      });
    }
    expect(internals(jit).regions).toBe(1);
    const source = internals(jit).regionSource!;
    // Both the promoted member and the cold block are in the region, and the
    // promoted slot lives in the shared local rather than a member local.
    expect((source.match(/F = FS\[\d+\];/g) ?? []).length).toBe(2);
    expect(source).toContain('rp0d = 1;');
    expect(source).not.toContain('m0_ps');
    expect(jit.storage.loadState(fixture.acc)).toBe(reference.storage.loadState(fixture.acc));
  });

  it('writes back member promotions when a member traps inside the region', () => {
    // The trap is the only exit of the member that owns the array promotion, so
    // the region's catch block is the only place the dirty local can be
    // published. The `trap` argument stays 0 while the chain warms up, so the
    // final execution is the one that fails inside compiled region code.
    const build = () => {
      const module = createIRModule();
      const registers = module.array('registers', 'u32', new Array<number>(4).fill(0));
      const blocks = module.provider(
        'blocks',
        {
          keyTypes: ['u32'],
          params: ['u32', 'u32'],
          results: ['u32'],
          reads: [],
          imports: [registers],
        },
        (gen, [key]) => {
          if (key !== 0) {
            return gen.function((b, [value, trap]) => {
              b.dispatch(blocks, [b.const('u32', 0)], [b.int.sub(value, b.const('u32', 1)), trap]);
            });
          }
          return gen.function((b, [value, trap]) => {
            const head = b.block(['u32']);
            const body = b.block(['u32']);
            const after = b.block([]);
            const more = b.block([]);
            const stop = b.block([]);
            const boom = b.block([]);
            const done = b.block([]);
            b.jump(head, [b.const('u32', 0)]);
            b.at(head, (inner, [index]) =>
              inner.branch(
                inner.int.cmp('lt', index, inner.const('u32', 1)),
                { target: body, args: [index] },
                { target: after, args: [] },
              ),
            );
            b.at(body, (inner, [index]) => {
              const slot = inner.const('u32', 2);
              const current = inner.array.load(registers, slot);
              inner.array.store(registers, slot, inner.int.add(current, inner.const('u32', 1)));
              inner.jump(head, [inner.int.add(index, inner.const('u32', 1))]);
            });
            b.at(after, (inner) =>
              inner.branch(
                inner.int.cmp('gt', value, inner.const('u32', 0)),
                { target: more, args: [] },
                { target: stop, args: [] },
              ),
            );
            b.at(more, (inner) =>
              inner.dispatch(
                blocks,
                [inner.const('u32', 1)],
                [inner.int.sub(value, inner.const('u32', 1)), trap],
              ),
            );
            b.at(stop, (inner) =>
              inner.branch(
                inner.int.cmp('ne', trap, inner.const('u32', 0)),
                { target: boom, args: [] },
                { target: done, args: [] },
              ),
            );
            b.at(boom, (inner) => inner.trap('boom'));
            b.at(done, (inner) =>
              inner.return([inner.array.load(registers, inner.const('u32', 2))]),
            );
          });
        },
      );
      const run = module.func('run', { params: ['u32'], results: ['u32'] });
      run.body((b, [trap]) => b.dispatch(blocks, [b.const('u32', 0)], [b.const('u32', 10), trap]));
      return { module, run, registers };
    };
    const jitFixture = build();
    const referenceFixture = build();
    const jit = createIRJIT(jitFixture.module, {
      validation: policy(jitFixture.module),
      maxSteps: 1e9,
    });
    const reference = createIRInterpreter(referenceFixture.module, {
      validation: policy(referenceFixture.module),
      maxSteps: 1e9,
    });
    const capture = (engine: typeof jit, target: typeof jitFixture.run, trap: number) => {
      try {
        return { ok: true as const, values: engine.execute(target, [trap], context).values };
      } catch (error) {
        if (!(error instanceof IRExecutionError)) throw error;
        return { ok: false as const, code: error.code };
      }
    };
    // Six entries per run (values 10, 8, 6, 4, 2, 0), so 100 runs cross
    // REGION_THRESHOLD with real dispatches.
    for (let index = 0; index < 100; index += 1) {
      expect(capture(jit, jitFixture.run, 0)).toEqual(capture(reference, referenceFixture.run, 0));
    }
    expect(internals(jit).regions).toBe(1);
    // Every access to the register array uses a constant index, so the element
    // is promoted region-wide: one shared local that survives a member
    // boundary instead of one private copy per member.
    expect(internals(jit).regionSource!).not.toMatch(/m\d+_ps0d/);
    expect(internals(jit).regionSource!).toMatch(/rp\d+ = S\d+\.view\[2\]/);
    const before = jit.storage.loadArray(jitFixture.registers, 2);
    expect(capture(jit, jitFixture.run, 1)).toEqual(capture(reference, referenceFixture.run, 1));
    // The trapping entry stored once before it reached the trap.
    expect(jit.storage.loadArray(jitFixture.registers, 2)).toBe(before + 6);
    expect(jit.storage.loadArray(jitFixture.registers, 2)).toBe(
      reference.storage.loadArray(referenceFixture.registers, 2),
    );
  });

  it('batches the step counter and control flags per tick by default', () => {
    const run = (checkpointGranularity?: 'per-instruction' | 'per-tick') => {
      const { module, run: target } = guestLoopFixture();
      const jit = createIRJIT(module, {
        validation: policy(module),
        // An unbounded budget makes every per-item budget check dead code, so
        // the region can batch the counter (J16). A finite budget keeps the
        // exact per-block accounting in both granularities.
        maxSteps: Number.MAX_SAFE_INTEGER,
        jit: checkpointGranularity === undefined ? {} : { checkpointGranularity },
      });
      for (let index = 0; index < WARM_RUNS; index += 1) execute(jit, target, [LOOP_LENGTH]);
      return internals(jit).regionSource ?? '';
    };
    const perTick = run();
    expect(perTick).toMatch(/let S = 0;/);
    expect(perTick).toMatch(/rt\.steps \+= S/);
    expect(perTick).toMatch(/let SUS = H\.ctl\.suspended;/);
    expect(perTick).not.toMatch(/H\.ctl\.suspended !== 0/);

    const perInstruction = run('per-instruction');
    expect(perInstruction).not.toMatch(/let S = 0;/);
    expect(perInstruction).not.toMatch(/let SUS = H\.ctl\.suspended;/);
    expect(perInstruction).toMatch(/rt\.steps \+= \d+;/);
  });

  it('does not form regions when the pass is disabled', () => {
    const { module, run, calls } = guestLoopFixture();
    const jit = createIRJIT(module, {
      validation: policy(module),
      jit: { optimizations: { regions: false } },
    });
    for (let index = 0; index < WARM_RUNS; index += 1) execute(jit, run, [LOOP_LENGTH]);
    expect(internals(jit).regions).toBe(0);
    expect(internals(jit).regionSource).toBeUndefined();
    expect(calls.generated).toBe(2);
  });

  it('matches the reference at every step budget boundary', () => {
    const build = (maxSteps: number) => {
      const fixture = guestLoopFixture();
      return {
        fixture,
        jit: createIRJIT(fixture.module, {
          validation: policy(fixture.module),
          maxSteps,
        }),
        reference: createIRInterpreter(fixture.module, {
          validation: policy(fixture.module),
          maxSteps,
        }),
      };
    };
    const capture = (action: () => { values: readonly RuntimeScalar[]; steps: number }) => {
      try {
        const result = action();
        return { ok: true as const, values: result.values, steps: result.steps };
      } catch (error) {
        if (!(error instanceof IRExecutionError)) throw error;
        return { ok: false as const, code: error.code, steps: error.steps };
      }
    };
    for (let maxSteps = 0; maxSteps <= 24; maxSteps += 1) {
      const { fixture, jit, reference } = build(maxSteps);
      // A one-iteration run needs about six steps. Larger budgets warm the
      // chain until a region exists, so the final run crosses at least one
      // budget boundary inside compiled region code.
      const probe = createIRInterpreter(fixture.module, { validation: policy(fixture.module) });
      const oneShot = probe.execute(fixture.run, [1], context);
      if (oneShot.steps <= maxSteps) {
        for (let index = 0; index < REGION_THRESHOLD + 10; index += 1) {
          jit.execute(fixture.run, [1], context);
        }
      }
      const expected = capture(() => reference.execute(fixture.run, [LOOP_LENGTH], context));
      const actual = capture(() => jit.execute(fixture.run, [LOOP_LENGTH], context));
      expect({ maxSteps, actual }).toEqual({ maxSteps, actual: expected });
    }
  }, 120_000);

  it('documents the threshold that starts region compilation', () => {
    expect(REGION_THRESHOLD).toBe(500);
  });
});

/* -------------------------------------------------------------------------
 * Inter-region direct calls (J15)
 * ---------------------------------------------------------------------- */

describe('region identity and exit profile', () => {
  it('derives a key that survives a recompilation of the same members', () => {
    const first = fakeState(3);
    const second = fakeState(7);
    expect(regionKeyOf(2, [first, second])).toBe(regionKeyOf(2, [second, first]));
    expect(regionKeyOf(2, [first, second])).not.toBe(regionKeyOf(3, [first, second]));
    expect(regionKeyOf(2, [first])).not.toBe(regionKeyOf(2, [first, second]));
  });

  it('counts exits until a target crosses the direct-call threshold', () => {
    const profile = createRegionExitProfile();
    const hot = fakeState(1);
    const cold = fakeState(2);
    expect(profile.budget).toBe(REGION_PROFILE_BUDGET);
    for (let index = 1; index < REGION_DIRECT_CALL_THRESHOLD; index += 1) {
      expect(recordRegionExit(profile, hot)).toBe(false);
    }
    expect(recordRegionExit(profile, hot)).toBe(true);
    // Counts saturate at twice the threshold, so a long-running region never
    // grows them; repeats keep reporting the request until the engine resets.
    for (let index = 0; index < REGION_DIRECT_CALL_THRESHOLD * 3; index += 1) {
      recordRegionExit(profile, hot);
    }
    const saturated = profile.slots.find((slot) => slot.state === hot)!.count;
    expect(saturated).toBe(REGION_DIRECT_CALL_THRESHOLD * 2);
    recordRegionExit(profile, hot);
    expect(profile.slots.find((slot) => slot.state === hot)!.count).toBe(saturated);
    // Repeats of one target do not fill the table.
    recordRegionExit(profile, cold);
    expect(profile.slots).toHaveLength(2);
  });

  it('ignores new targets once the slot table is full and stops at the budget', () => {
    const profile = createRegionExitProfile();
    for (let index = 0; index < REGION_PROFILE_SLOTS + 4; index += 1) {
      recordRegionExit(profile, fakeState(index));
    }
    expect(profile.slots).toHaveLength(REGION_PROFILE_SLOTS);
    profile.budget = 1;
    expect(recordRegionExit(profile, fakeState(99))).toBe(false);
    expect(profile.budget).toBe(0);
    expect(recordRegionExit(profile, fakeState(98))).toBe(false);
  });
});

/**
 * A ring of `count` blocks that stops after a dispatch budget.
 *
 * Region formation stops at {@link MAX_REGION_MEMBERS}, so a ring longer than
 * that leaves the tail artifacts outside the first region; they form a second
 * one, and the two regions then hand control back and forth. That is the shape
 * the direct-call paths exist for.
 */
function ringFixture(count: number) {
  const module = createIRModule();
  const limit = module.state('limit', 'u32', 0);
  // The dispatch counter travels as a provider argument: a read-modify-write
  // state slot in the artifact body would be slot-promoted, and promoted
  // artifacts stay out of regions.
  const blocks = module.provider(
    'blocks',
    {
      keyTypes: ['u32'],
      params: ['u32'],
      results: [],
      reads: [],
      imports: [limit],
    },
    (gen, [key]) =>
      gen.function((b, [tick]) => {
        const next = b.int.add(tick, b.const('u32', 1));
        const more = b.block([]);
        const stop = b.block([]);
        b.branch(
          b.int.cmp('lt', next, b.state.load(limit)),
          { target: more, args: [] },
          { target: stop, args: [] },
        );
        b.at(more, (inner) =>
          inner.dispatch(blocks, [inner.const('u32', (key + 1) % count)], [next]),
        );
        b.at(stop, (inner) => inner.return([]));
      }),
  );
  const step = module.func('step', { params: ['u32'], results: [] });
  step.body((b, [dispatchLimit]) => {
    b.state.store(limit, dispatchLimit);
    b.dispatch(blocks, [b.const('u32', 0)], [b.const('u32', 0)]);
  });
  return { module, step };
}

const RING_BLOCKS = 40;
const RING_LIMIT = 200;
const RING_RUNS = 200;
/** Runs the trap fixture executes before the trap arms. */
const TRAP_WARM_RUNS = 400;

function ringRun(mode: 'direct' | 'trampoline') {
  const jitFixture = ringFixture(RING_BLOCKS);
  const referenceFixture = ringFixture(RING_BLOCKS);
  const jit = createIRJIT(jitFixture.module, {
    validation: policy(jitFixture.module),
    maxSteps: 1e9,
    ...(mode === 'trampoline' ? { jit: { optimizations: { regionDirectCall: false } } } : {}),
  });
  const reference = createIRInterpreter(referenceFixture.module, {
    validation: policy(referenceFixture.module),
    maxSteps: 1e9,
  });
  let regionSource: string | undefined;
  for (let index = 0; index < RING_RUNS; index += 1) {
    const actual = jit.execute(jitFixture.step, [RING_LIMIT], context);
    const expected = reference.execute(referenceFixture.step, [RING_LIMIT], context);
    expect({ index, values: actual.values, steps: actual.steps }).toEqual({
      index,
      values: expected.values,
      steps: expected.steps,
    });
    regionSource = internals(jit).regionSource ?? regionSource;
  }
  return { jit, source: regionSource ?? '' };
}

describe('inter-region direct calls', () => {
  it('splits a ring longer than the member bound across several regions', () => {
    const { jit, source } = ringRun('trampoline');
    // The source budget keeps every region optimizable, so a long ring ends up
    // spread over more than one region and crossings are real exits.
    expect(internals(jit).regions).toBeGreaterThan(1);
    // The trampoline path leaves every crossing to `runTail`.
    expect(source).not.toMatch(/\.region;/);
    expect(source).toContain('return rt.TAIL;');
  });

  it('continues a crossing inside the callee region without the trampoline', () => {
    const { jit, source } = ringRun('direct');
    expect(internals(jit).regions).toBeGreaterThan(1);
    // The cache-hit exit resolves the owning region and calls it directly.
    expect(source).toMatch(/\.region;/);
    expect(source).toMatch(/\.fn\(/);
    expect(internals(jit).regionRebuilds).toBeGreaterThan(0);
    expect(internals(jit).regionDirectCalls).toBeGreaterThan(0);
  });

  it('keeps the emitted region inside the code-size budget', () => {
    // Per-member size, not the raw total: the two runs pick different member
    // sets (the source budget drops members until a region fits, so a small
    // codegen difference changes which regions exist at all). What the guard
    // really protects is that a direct-call guard stays a fixed epilogue per
    // member instead of multiplying the body.
    const perMember = (source: string): number =>
      source.length / Math.max(1, (source.match(/F = FS\[\d+\];/g) ?? []).length);
    const direct = perMember(ringRun('direct').source);
    const trampoline = perMember(ringRun('trampoline').source);
    expect(trampoline).toBeGreaterThan(0);
    expect(direct).toBeLessThanOrEqual(trampoline * 1.15);
  }, 120_000);

  it('reports the same error when a direct call traps', () => {
    const build = () => {
      const module = createIRModule();
      const armed = module.state('armed', 'u32', 0);
      const blocks = module.provider(
        'blocks',
        { keyTypes: ['u32'], params: ['u32'], results: [], reads: [], imports: [armed] },
        (gen, [key]) =>
          gen.function((b, [tick]) => {
            const next = b.int.add(tick, b.const('u32', 1));
            // Long runs while warming, three dispatches once armed: the trap
            // then happens inside a compiled region.
            const warming = b.int.cmp('lt', b.state.load(armed), b.const('u32', TRAP_WARM_RUNS));
            const limit = b.select(warming, b.const('u32', 40), b.const('u32', 3));
            const more = b.block([]);
            const leave = b.block([]);
            const stop = b.block([]);
            const boom = b.block([]);
            b.branch(
              b.int.cmp('lt', next, limit),
              { target: more, args: [] },
              { target: leave, args: [] },
            );
            b.at(more, (inner) =>
              inner.dispatch(blocks, [inner.const('u32', (key + 1) % 4)], [next]),
            );
            b.at(leave, (inner) =>
              inner.branch(warming, { target: stop, args: [] }, { target: boom, args: [] }),
            );
            b.at(stop, (inner) => inner.return([]));
            b.at(boom, (inner) => inner.trap('boom'));
          }),
      );
      const step = module.func('step', { params: [], results: [] });
      step.body((b) => {
        b.state.store(armed, b.int.add(b.state.load(armed), b.const('u32', 1)));
        b.dispatch(blocks, [b.const('u32', 0)], [b.const('u32', 0)]);
      });
      return { module, step };
    };
    const jitFixture = build();
    const referenceFixture = build();
    const jit = createIRJIT(jitFixture.module, {
      validation: policy(jitFixture.module),
      maxSteps: 1e9,
    });
    const reference = createIRInterpreter(referenceFixture.module, {
      validation: policy(referenceFixture.module),
      maxSteps: 1e9,
    });
    const capture = (engine: typeof jit, step: typeof jitFixture.step) => {
      try {
        engine.execute(step, [], context);
        return undefined;
      } catch (error) {
        if (!(error instanceof IRExecutionError)) throw error;
        return { code: error.code, steps: error.steps, callStack: error.callStack };
      }
    };
    let compared = false;
    for (let index = 0; index < TRAP_WARM_RUNS + 5; index += 1) {
      const actual = capture(jit, jitFixture.step);
      const expected = capture(reference, referenceFixture.step);
      expect(actual).toEqual(expected);
      if (expected === undefined) continue;
      // The trapping run happens after the regions were built.
      expect(internals(jit).regions).toBeGreaterThan(0);
      expect(expected.code).toBe('trap');
      compared = true;
      break;
    }
    expect(compared).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Region-wide promotions (J16)
 * ---------------------------------------------------------------------- */

describe('region promotions', () => {
  const memories = [
    {
      name: 'registers',
      kind: 'array',
      layout: { kind: 'scalar', scalarType: 'u32', length: 16 },
      writable: true,
    },
    {
      name: 'peripheral',
      kind: 'bytes',
      layout: { kind: 'bytes', length: 256 },
      writable: true,
    },
  ] as unknown as readonly MemoryDefinition[];

  /** A one-block member whose values are all `u32` SSA values. */
  function member(
    insts: readonly MInst[],
    constants: readonly (readonly [ValueId, number])[],
  ): RegionMember {
    const values: unknown[] = [];
    for (const [id, literal] of constants) {
      values[id] = {
        id,
        type: 'u32',
        rep: 'U',
        def: {
          op: Op.Const,
          args: [],
          results: [id],
          imm: [literal],
          refs: [],
          node: undefined,
          loc: 0,
          step: 0,
        } satisfies MInst,
      };
    }
    // A block parameter is not an instruction, so `constantNumber` cannot fold
    // it: `instructionOf` recognises the definition by its `insts` list.
    values[valueCount] = {
      id: valueCount,
      type: 'u32',
      rep: 'U',
      def: { id: valueCount, params: [valueCount], insts: [] },
    };
    return {
      mir: { blocks: [{ insts }], values, promotions: [] },
    } as unknown as RegionMember;
  }

  const DYNAMIC: ValueId = 0;
  const valueCount = 1;
  const constAt = (id: number, literal: number): readonly [ValueId, number] => [id, literal];
  const arrayLoad = (memory: number, index: ValueId, result: ValueId): MInst => ({
    op: Op.ArrayLoad,
    args: [index],
    results: [result],
    imm: [],
    refs: [memory],
    node: undefined,
    loc: 0,
    step: 0,
  });
  const bytesAccess = (
    op: Op.BytesLoad | Op.BytesStore,
    memory: number,
    offset: ValueId,
    value: ValueId,
  ): MInst => ({
    op,
    args: op === Op.BytesStore ? [offset, value] : [offset],
    results: op === Op.BytesLoad ? [value] : [],
    imm: ['u32', 'little'],
    refs: [memory],
    node: undefined,
    loc: 0,
    step: 0,
  });

  it('promotes a constant-index element that survives a member boundary', () => {
    const first = member([arrayLoad(0, 2, 3)], [constAt(2, 7), constAt(3, 4)]);
    const second = member([arrayLoad(0, 2, 3)], [constAt(2, 7), constAt(3, 4)]);
    const promotions = collectRegionPromotions([first, second], memories);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ memory: 0, index: 7, type: 'u32' });
  });

  it('leaves an array with a dynamic access in storage', () => {
    const first = member(
      [arrayLoad(0, 2, 3), arrayLoad(0, DYNAMIC, 4)],
      [constAt(2, 7), constAt(3, 4), constAt(4, 5)],
    );
    const second = member([arrayLoad(0, 2, 3)], [constAt(2, 7), constAt(3, 4)]);
    expect(collectRegionPromotions([first, second], memories)).toHaveLength(0);
  });

  it('promotes non-overlapping constant byte intervals', () => {
    const first = member([bytesAccess(Op.BytesStore, 1, 2, 3)], [constAt(2, 8), constAt(3, 4)]);
    const second = member([bytesAccess(Op.BytesLoad, 1, 2, 3)], [constAt(2, 8), constAt(3, 4)]);
    const promotions = collectRegionPromotions([first, second], memories);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ memory: 1, bytes: { offset: 8, numeric: 'u32' } });
  });

  it('refuses byte intervals that alias each other', () => {
    // A `u32` at 8 covers bytes 8..12; a second interval at 9 would disagree
    // with it, so the whole resource stays in storage.
    const first = member(
      [
        bytesAccess(Op.BytesStore, 1, 2, 3),
        bytesAccess(Op.BytesLoad, 1, 2, 3),
        bytesAccess(Op.BytesLoad, 1, 4, 5),
      ],
      [constAt(2, 8), constAt(3, 4), constAt(4, 9), constAt(5, 6)],
    );
    const second = member([bytesAccess(Op.BytesLoad, 1, 2, 3)], [constAt(2, 8), constAt(3, 4)]);
    expect(collectRegionPromotions([first, second], memories)).toHaveLength(0);
  });

  it('refuses a byte resource a range fill wrote', () => {
    const fill: MInst = {
      op: Op.ResourceFillBytes,
      args: [],
      results: [],
      imm: [],
      refs: [1],
      node: undefined,
      loc: 0,
      step: 0,
    };
    const first = member(
      [bytesAccess(Op.BytesStore, 1, 2, 3), fill],
      [constAt(2, 8), constAt(3, 4)],
    );
    const second = member([bytesAccess(Op.BytesLoad, 1, 2, 3)], [constAt(2, 8), constAt(3, 4)]);
    expect(collectRegionPromotions([first, second], memories)).toHaveLength(0);
  });
});
