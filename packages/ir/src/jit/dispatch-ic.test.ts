/**
 * J14 dispatch inline caches.
 *
 * The unit cases pin the two properties the generated guards rely on:
 * normalized key identity (float `Object.is`, integer `===`) and the
 * direct-mapped jump-cache hash. The engine cases exercise the full protocol
 * (site hit, rotation, jump cache, epoch invalidation) and assert the provider
 * generation counts, which are the externally visible fingerprint of the
 * reference `materialize` path.
 */
import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../builder';
import {
  createIRInterpreter,
  createIRModule,
  type IRExecutionContext,
  type IRModule,
  type IRResourcePermission,
  type IRValidationOptions,
  type RuntimeScalar,
} from '../index';
import { jitInternals, createIRJIT } from '../jit-runtime';
import type { IRJITInternals } from '../jit-runtime';
import type { Target } from '../engine-setup';
import {
  DISPATCH_IC_CAPACITY,
  DispatchRegistry,
  JUMP_CACHE_SIZE,
  JumpCache,
  dispatchKeysEqual,
  hashDispatchKey,
  providerDispatchInfo,
} from './dispatch-ic';
import type { ArtifactState, DispatchKey } from './dispatch-ic';

const context: IRExecutionContext = { instanceId: 'dispatch-ic', virtualTime: 3 };

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

/* -------------------------------------------------------------------------
 * Key identity and hashing
 * ---------------------------------------------------------------------- */

describe('dispatch IC keys', () => {
  it('compares integer and bool keys with strict equality', () => {
    expect(dispatchKeysEqual(['u32'], [7], [7])).toBe(true);
    expect(dispatchKeysEqual(['u32'], [7], [8])).toBe(false);
    expect(dispatchKeysEqual(['bool'], [true], [true])).toBe(true);
    expect(dispatchKeysEqual(['bool'], [true], [false])).toBe(false);
    expect(dispatchKeysEqual(['u32', 'bool'], [1, true], [1, true])).toBe(true);
    expect(dispatchKeysEqual(['u32'], [1], [1, 2])).toBe(false);
    expect(dispatchKeysEqual(['u32'], undefined, [1])).toBe(false);
  });

  it('uses float bit identity: NaN equals NaN and 0 differs from -0', () => {
    expect(dispatchKeysEqual(['f64'], [Number.NaN], [Number.NaN])).toBe(true);
    expect(dispatchKeysEqual(['f64'], [0], [-0])).toBe(false);
    expect(dispatchKeysEqual(['f64'], [0], [0])).toBe(true);
    expect(dispatchKeysEqual(['f32'], [0], [-0])).toBe(false);
    expect(dispatchKeysEqual(['f64'], [Number.POSITIVE_INFINITY], [Number.POSITIVE_INFINITY])).toBe(
      true,
    );
  });

  it('hashes a single u32 key with the J14 formula', () => {
    for (const key of [0, 1, 0x1234_5678, 0xffff_ffff, 0x1000_0000]) {
      expect(hashDispatchKey(['u32'], [key])).toBe((key ^ (key >>> 12)) & (JUMP_CACHE_SIZE - 1));
    }
  });

  it('hashes every key shape into range and deterministically', () => {
    const shapes: readonly (readonly [
      readonly ('u32' | 'f64' | 'bool')[],
      readonly DispatchKey[],
    ])[] = [
      [
        ['u32', 'u32'],
        [1, 2],
      ],
      [['f64'], [Number.NaN]],
      [['f64'], [-0]],
      [
        ['bool', 'u32'],
        [true, 9],
      ],
    ];
    for (const [types, keys] of shapes) {
      const hash = hashDispatchKey(types, keys);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(JUMP_CACHE_SIZE);
      expect(hashDispatchKey(types, keys)).toBe(hash);
    }
  });
});

/* -------------------------------------------------------------------------
 * Jump cache
 * ---------------------------------------------------------------------- */

function fakeState(key: readonly DispatchKey[], index = key[0] as number): ArtifactState {
  return {
    artifact: { index },
    key,
    providerIndex: 0,
    mir: undefined,
    compiled: { fn: () => index },
    dependencies: [],
    storageEpoch: 0,
    providerEpoch: 0,
    validatedEpoch: -1,
    entries: 0,
    region: undefined,
    regionIndex: -1,
  } as unknown as ArtifactState;
}

describe('jump cache', () => {
  it('probes keys by equality and epochs after a direct-mapped store', () => {
    const cache = new JumpCache();
    const first = fakeState([0], 1);
    cache.store(['u32'], [0], first, 4, 7);
    expect(cache.lookup(['u32'], [0], 4, 7)).toBe(first);
    expect(cache.lookup(['u32'], [0], 5, 7)).toBeUndefined();
    expect(cache.lookup(['u32'], [0], 4, 8)).toBeUndefined();
    expect(cache.lookup(['u32'], [1], 4, 7)).toBeUndefined();
  });

  it('keeps correct results when two keys collide in the same slot', () => {
    // Both keys hash to slot 0: h(k) = (k ^ (k >>> 12)) & 4095.
    const left = 0;
    const right = 0x1000_0000;
    expect(hashDispatchKey(['u32'], [left])).toBe(0);
    expect(hashDispatchKey(['u32'], [right])).toBe(0);
    const cache = new JumpCache();
    const a = fakeState([left], 1);
    const b = fakeState([right], 2);
    cache.store(['u32'], [left], a, 0, 0);
    expect(cache.lookup(['u32'], [left], 0, 0)).toBe(a);
    expect(cache.lookup(['u32'], [right], 0, 0)).toBeUndefined();
    cache.store(['u32'], [right], b, 0, 0);
    expect(cache.lookup(['u32'], [right], 0, 0)).toBe(b);
    expect(cache.lookup(['u32'], [left], 0, 0)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------
 * Site rotation
 * ---------------------------------------------------------------------- */

describe('dispatch site rotation', () => {
  it('fills four entries and rotates the oldest on the fifth record', () => {
    const registry = new DispatchRegistry(providerDispatchInfo([]));
    const site = registry.site(0, undefined);
    const states = [1, 2, 3, 4, 5].map((key) => fakeState([key], key));
    states.forEach((state, index) => registry.record(site, state.key, state, index, index));
    expect(site.count).toBe(DISPATCH_IC_CAPACITY);
    expect(site.misses).toBe(5);
    // The fifth record replaced slot 0; the oldest key is gone.
    expect(site.states[0]).toBe(states[4]);
    expect(site.states[1]).toBe(states[1]);
    expect(registry.stats().icMisses).toBe(5);
  });

  it('orders successors by observed transition counts', () => {
    const registry = new DispatchRegistry(providerDispatchInfo([]));
    const source = fakeState([0], 0);
    const hot = fakeState([0], 0);
    const cold = fakeState([1], 1);
    const site = registry.site(0, source);
    registry.record(site, hot.key, hot, 0, 0);
    registry.record(site, cold.key, cold, 0, 0);
    site.counts[0] = 9;
    site.counts[1] = 1;
    expect(registry.hottestSuccessors(source)).toEqual([hot, cold]);
  });
});

/* -------------------------------------------------------------------------
 * Engine protocol
 * ---------------------------------------------------------------------- */

function countingProvider() {
  const calls = { generated: 0, keys: [] as number[] };
  const module = createIRModule();
  const provider = module.provider(
    'lookup',
    { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [], imports: [] },
    (gen, [key]) => {
      calls.generated += 1;
      calls.keys.push(key);
      return gen.function((b, [value]) => b.return([b.int.add(value, b.const('u32', key))]));
    },
  );
  const run = module.func('run', { params: ['u32', 'u32'], results: ['u32'] });
  run.body((b, [value, key]) => b.dispatch(provider, [key], [value]));
  return { module, run, calls };
}

function execute(
  engine: ReturnType<typeof createIRJIT>,
  target: Target,
  args: readonly RuntimeScalar[],
): readonly RuntimeScalar[] {
  return engine.execute(target, args, context).values;
}

describe('dispatch IC engine protocol', () => {
  it('hits the monomorphic entry and skips materialize', () => {
    const { module, run, calls } = countingProvider();
    const jit = createIRJIT(module, { validation: policy(module) });
    expect(execute(jit, run, [10, 3])).toEqual([13]);
    expect(execute(jit, run, [20, 3])).toEqual([23]);
    expect(calls.generated).toBe(1);
    expect(internals(jit).icMisses).toBe(1);
    expect(internals(jit).icHits).toBeGreaterThanOrEqual(1);
    expect(internals(jit).jumpHits).toBeGreaterThanOrEqual(0);
  });

  it('keeps up to four polymorphic entries and rotates afterwards', () => {
    const { module, run, calls } = countingProvider();
    const jit = createIRJIT(module, { validation: policy(module) });
    for (const key of [1, 2, 3, 4]) expect(execute(jit, run, [0, key])).toEqual([key]);
    expect(calls.generated).toBe(4);
    // Generating key 2..4 bumps the global cache epoch, so entries written for
    // earlier keys are refreshed once; the third pass is fully hot.
    for (const key of [1, 2, 3, 4]) execute(jit, run, [0, key]);
    const misses = internals(jit).icMisses;
    const hits = internals(jit).icHits;
    for (const key of [1, 2, 3, 4]) execute(jit, run, [0, key]);
    expect(internals(jit).icMisses).toBe(misses);
    expect(internals(jit).icHits).toBe(hits + 4);
    // A fifth key rotates slot 0, so key 1 is evicted and misses again.
    expect(execute(jit, run, [0, 5])).toEqual([5]);
    expect(execute(jit, run, [0, 2])).toEqual([2]);
    expect(execute(jit, run, [0, 1])).toEqual([1]);
    expect(calls.generated).toBe(5);
  });

  it('falls back to materialize after the storage epoch changes', () => {
    const calls = { generated: 0 };
    const module = createIRModule();
    const firmware = module.bytes('firmware', new Uint8Array([1, 2, 3, 4]), {
      readonly: true,
      unitBytes: 2,
    });
    const provider = module.provider(
      'lookup',
      { keyTypes: ['u32'], params: ['u32'], results: ['u32'], reads: [firmware], imports: [] },
      (gen, [key]) => {
        calls.generated += 1;
        const byte = gen.readBytes(firmware, 0, 1)[0]!;
        return gen.function((b, [value]) =>
          b.return([b.int.add(value, b.const('u32', (key + byte) >>> 0))]),
        );
      },
    );
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => b.dispatch(provider, [b.const('u32', 7)], [value]));
    const jit = createIRJIT(module, {
      validation: policy(module, [{ ref: firmware, access: 'update' as const }]),
    });
    expect(execute(jit, run, [10])).toEqual([18]);
    expect(execute(jit, run, [10])).toEqual([18]);
    expect(calls.generated).toBe(1);
    expect(internals(jit).icHits).toBeGreaterThanOrEqual(1);

    jit.storage.updateBytesFromBytes(firmware, 0, new Uint8Array([5]));
    expect(execute(jit, run, [10])).toEqual([22]);
    expect(calls.generated).toBe(2);
    // The regenerated artifact is cached and hit again on the next dispatch.
    expect(execute(jit, run, [10])).toEqual([22]);
    expect(calls.generated).toBe(2);
  });

  it('treats float NaN as equal and 0 / -0 as distinct keys', () => {
    const calls = { generated: 0 };
    const module = createIRModule();
    const provider = module.provider(
      'floatKey',
      { keyTypes: ['f64'], params: [], results: ['u32'], reads: [], imports: [] },
      (gen) => {
        calls.generated += 1;
        return gen.function((b) => b.return([b.const('u32', 7)]));
      },
    );
    const run = module.func('run', { params: ['f64'], results: ['u32'] });
    run.body((b, [key]) => b.dispatch(provider, [key], []));
    const jit = createIRJIT(module, { validation: policy(module) });
    execute(jit, run, [Number.NaN]);
    execute(jit, run, [Number.NaN]);
    expect(calls.generated).toBe(1);
    execute(jit, run, [0]);
    execute(jit, run, [-0]);
    expect(calls.generated).toBe(3);
  });

  it('leaves dispatch correctness untouched when the pass is disabled', () => {
    const { module, run, calls } = countingProvider();
    const jit = createIRJIT(module, {
      validation: policy(module),
      jit: { optimizations: { dispatchIC: false } },
    });
    expect(execute(jit, run, [1, 2])).toEqual([3]);
    expect(execute(jit, run, [1, 2])).toEqual([3]);
    expect(calls.generated).toBe(1);
    expect(internals(jit).icHits).toBe(0);
    expect(internals(jit).icMisses).toBe(0);
  });

  it('matches the reference through dispatch caching', () => {
    const { module, run } = countingProvider();
    const jit = createIRJIT(module, { validation: policy(module) });
    const reference = createIRInterpreter(module, { validation: policy(module) });
    for (const args of [
      [0, 0],
      [5, 2],
      [9, 2],
      [0xffff_ffff, 0xffff_ffff],
      [1, 2],
    ] as const) {
      expect(execute(jit, run, [...args])).toEqual(
        reference.execute(run, [...args], context).values,
      );
    }
  });
});
