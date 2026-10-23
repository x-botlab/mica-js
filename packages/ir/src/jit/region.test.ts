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
import { collectRegionMembers } from './region';

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
