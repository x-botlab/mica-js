/**
 * Dispatch inline caches (J14).
 *
 * Provider dispatch is the hot path of a DBT guest: every guest basic block
 * ends with a `dispatch`, and the reference `materialize` path validates the
 * provider metadata, normalizes the key, probes the provider cache and walks
 * every dependency on each call. The invariants introduced by J3 make that
 * work unnecessary while two epochs are unchanged:
 *
 * - **I1** (`StorageControl.epoch`): equal reads imply no dependency token was
 *   invalidated in between.
 * - **I2** (`ProviderRuntime.cacheEpoch`): equal reads imply no provider cache
 *   entry was added or replaced in between.
 *
 * Lemma **L**: after `materialize(P, k)` returns A, recording `E = epoch` and
 * `C = cacheEpoch` makes `materialize(P, k)` return A for as long as both
 * values stay unchanged, without executing any host code. A hit may therefore
 * skip `beforeHost` / `materialize` / `afterHost` and call A directly.
 *
 * Each dispatch site owns a small monomorphic/polymorphic cache (1–4 entries)
 * with a rotating replacement policy. A per-provider 4096-entry direct-mapped
 * jump cache catches the remaining key reuse; its hash follows the J14
 * specification (a single u32 key uses `(k ^ (k >>> 12)) & 4095`, everything
 * else FNV-1a). Both caches are keyed by the *normalized* key values produced
 * by `ProviderRuntime.normalizeKey` semantics: floats are canonicalized with
 * `toNumber(fromNumber(...))`, compared with `Object.is` so `NaN` equals `NaN`
 * and `0` differs from `-0`.
 *
 * The registry also records per-entry transition counts. When an artifact is
 * entered `REGION_THRESHOLD` times, the engine turns the hottest chain of
 * successors into a region (see `./region`).
 */
import type { ProviderArtifact } from '../provider';
import { isFloatType, isIntegerType } from '../runtime';
import type { IRResourceDependency } from '../storage';
import type { ScalarType } from '../types';
import type { MFunction } from './mir';
import type { CompiledFn } from './runtime-core';

/** Entries per dispatch site (monomorphic → polymorphic). */
export const DISPATCH_IC_CAPACITY = 4;

/** Direct-mapped jump-cache size; must stay a power of two. */
export const JUMP_CACHE_SIZE = 4096;

/** Entries into one artifact before the engine attempts region formation. */
export const REGION_THRESHOLD = 500;

/** Upper bound on the members of one compiled region. */
export const MAX_REGION_MEMBERS = 32;

/** A normalized provider key value. */
export type DispatchKey = boolean | number;

/** A compiled region handle attached to every member artifact. */
export interface RegionHandle {
  /** `(memberIndex, ...arguments)`; the arguments use MIR representations. */
  readonly fn: CompiledFn;
  readonly members: readonly ArtifactState[];
}

/**
 * Per-artifact state shared by the generated code, the IC and the region
 * runtime. The engine's `ArtifactEntry` implements this interface.
 */
export interface ArtifactState {
  readonly artifact: ProviderArtifact;
  /** Normalized key values that produced this artifact. */
  readonly key: readonly DispatchKey[];
  /** Model provider index that produced this artifact. */
  readonly providerIndex: number;
  readonly mir: MFunction;
  /** The current compiled function; replaced by tiering/recompilation. */
  compiled: { readonly fn: CompiledFn };
  dependencies: readonly IRResourceDependency[];
  /** Storage epoch when this artifact was last validated. */
  storageEpoch: number;
  /** Provider cache epoch when this artifact was last validated. */
  providerEpoch: number;
  /**
   * Storage epoch at which the artifact's dependencies were last verified.
   * `-1` means "never"; a checkpoint may skip `validate` while the current
   * epoch still equals this value.
   */
  validatedEpoch: number;
  /** Dispatch entries; region formation triggers at {@link REGION_THRESHOLD}. */
  entries: number;
  /** Compiled region that contains this artifact, when one was built. */
  region: RegionHandle | undefined;
  /** Index of this artifact inside {@link region}. */
  regionIndex: number;
}

/** Static metadata for one provider needed by code generation. */
export interface ProviderDispatchInfo {
  readonly keyTypes: readonly ScalarType[];
  readonly params: readonly ScalarType[];
  readonly results: readonly ScalarType[];
}

/**
 * One dispatch site's cache. Property names are part of the generated-code
 * contract (`IC0.states[0]`, `IC0.es[0]`, ...).
 */
export interface DispatchSite {
  readonly providerIndex: number;
  /** Artifact whose body owns this site (`undefined` for model functions). */
  readonly from: ArtifactState | undefined;
  readonly keyTypes: readonly ScalarType[];
  readonly keyCount: number;
  readonly states: (ArtifactState | undefined)[];
  readonly keys: (readonly DispatchKey[] | undefined)[];
  /** Storage epoch recorded after `materialize` returned. */
  readonly es: number[];
  /** Provider cache epoch recorded after `materialize` returned. */
  readonly cs: number[];
  /** Hit counts, used to order region successors by hotness. */
  readonly counts: number[];
  /** Number of filled entries (0–4). */
  count: number;
  /** Rotating replacement cursor. */
  next: number;
  hits: number;
  misses: number;
}

interface JumpEntry {
  readonly keys: readonly DispatchKey[];
  readonly state: ArtifactState;
  readonly es: number;
  readonly cs: number;
}

const floatScratch = new Uint32Array(2);
const float32Scratch = new Float32Array(floatScratch.buffer);
const float64Scratch = new Float64Array(floatScratch.buffer);

/**
 * Compare two normalized keys. Integer and bool keys use `===`; float keys
 * use `Object.is`, which reproduces `normalizeKey`'s bit-string identity:
 * every NaN is canonical and therefore equal, while `0` and `-0` differ.
 */
export function dispatchKeysEqual(
  keyTypes: readonly ScalarType[],
  left: readonly DispatchKey[] | undefined,
  right: readonly DispatchKey[],
): boolean {
  if (left === undefined || left.length !== right.length || left.length !== keyTypes.length) {
    return false;
  }
  for (let index = 0; index < keyTypes.length; index += 1) {
    const type = keyTypes[index]!;
    const a = left[index]!;
    const b = right[index]!;
    if (isFloatType(type)) {
      if (!Object.is(a, b)) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

/** J14 jump-cache hash. Always returns an index in `[0, JUMP_CACHE_SIZE)`. */
export function hashDispatchKey(
  keyTypes: readonly ScalarType[],
  keys: readonly DispatchKey[],
): number {
  if (keys.length === 1 && isIntegerType(keyTypes[0]!)) {
    const key = keys[0] as number;
    return (key ^ (key >>> 12)) & (JUMP_CACHE_SIZE - 1);
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < keys.length; index += 1) {
    const type = keyTypes[index]!;
    const value = keys[index]!;
    if (typeof value === 'boolean') {
      hash = Math.imul(hash ^ (value ? 1 : 0), 0x01000193);
    } else if (isFloatType(type)) {
      if (type === 'f32') {
        float32Scratch[0] = value;
        hash = Math.imul(hash ^ floatScratch[0]!, 0x01000193);
      } else {
        float64Scratch[0] = value;
        hash = Math.imul(hash ^ floatScratch[0]!, 0x01000193);
        hash = Math.imul(hash ^ floatScratch[1]!, 0x01000193);
      }
    } else {
      hash = Math.imul(hash ^ (value | 0), 0x01000193);
    }
  }
  return (hash >>> 0) & (JUMP_CACHE_SIZE - 1);
}

/** One 4096-entry direct-mapped cache, private to a provider. */
export class JumpCache {
  readonly #slots: (JumpEntry | undefined)[] = new Array<JumpEntry | undefined>(JUMP_CACHE_SIZE);

  lookup(
    keyTypes: readonly ScalarType[],
    keys: readonly DispatchKey[],
    storageEpoch: number,
    cacheEpoch: number,
  ): ArtifactState | undefined {
    const entry = this.#slots[hashDispatchKey(keyTypes, keys)];
    if (entry === undefined) return undefined;
    if (entry.es !== storageEpoch || entry.cs !== cacheEpoch) return undefined;
    if (!dispatchKeysEqual(keyTypes, entry.keys, keys)) return undefined;
    return entry.state;
  }

  store(
    keyTypes: readonly ScalarType[],
    keys: readonly DispatchKey[],
    state: ArtifactState,
    storageEpoch: number,
    cacheEpoch: number,
  ): void {
    this.#slots[hashDispatchKey(keyTypes, keys)] = {
      keys,
      state,
      es: storageEpoch,
      cs: cacheEpoch,
    };
  }
}

/**
 * Per-engine dispatch bookkeeping: site registration, jump caches, hotness
 * counters and the transition counts used to form regions.
 */
export class DispatchRegistry {
  readonly sites: DispatchSite[] = [];
  readonly #providers: readonly ProviderDispatchInfo[];
  readonly #jumpCaches: (JumpCache | undefined)[] = [];
  jumpHits = 0;
  jumpMisses = 0;

  constructor(providers: readonly ProviderDispatchInfo[] = []) {
    this.#providers = providers;
  }

  provider(providerIndex: number): ProviderDispatchInfo | undefined {
    return this.#providers[providerIndex];
  }

  /** Called once per compiled function instantiation and dispatch site. */
  site(providerIndex: number, from: ArtifactState | undefined): DispatchSite {
    const info = this.#providers[providerIndex];
    const site: DispatchSite = {
      providerIndex,
      from,
      keyTypes: info?.keyTypes ?? [],
      keyCount: info?.keyTypes.length ?? 0,
      states: new Array<ArtifactState | undefined>(DISPATCH_IC_CAPACITY),
      keys: new Array<readonly DispatchKey[] | undefined>(DISPATCH_IC_CAPACITY),
      es: [-1, -1, -1, -1],
      cs: [-1, -1, -1, -1],
      counts: [0, 0, 0, 0],
      count: 0,
      next: 0,
      hits: 0,
      misses: 0,
    };
    this.sites.push(site);
    return site;
  }

  /** Record one materialization: rotate the site entry and update the jump cache. */
  record(
    site: DispatchSite,
    keys: readonly DispatchKey[],
    state: ArtifactState,
    storageEpoch: number,
    cacheEpoch: number,
  ): void {
    site.misses += 1;
    const slot = site.next;
    site.states[slot] = state;
    site.keys[slot] = keys;
    site.es[slot] = storageEpoch;
    site.cs[slot] = cacheEpoch;
    site.counts[slot] = 1;
    site.next = (slot + 1) % DISPATCH_IC_CAPACITY;
    if (site.count < DISPATCH_IC_CAPACITY) site.count += 1;
    // Lemma L: a fresh/cached artifact is valid at the recorded epochs, so the
    // next checkpoint inside it may skip `validate`.
    state.validatedEpoch = storageEpoch;
    state.storageEpoch = storageEpoch;
    state.providerEpoch = cacheEpoch;
    this.#jumpCache(site.providerIndex)?.store(
      site.keyTypes,
      keys,
      state,
      storageEpoch,
      cacheEpoch,
    );
  }

  /** Provider jump-cache probe; the caller still has to check the key itself. */
  jumpHit(
    providerIndex: number,
    keys: readonly DispatchKey[],
    storageEpoch: number,
    cacheEpoch: number,
  ): ArtifactState | undefined {
    const cache = this.#jumpCache(providerIndex);
    const info = this.#providers[providerIndex];
    const state = cache?.lookup(info?.keyTypes ?? [], keys, storageEpoch, cacheEpoch);
    if (state === undefined) {
      this.jumpMisses += 1;
      return undefined;
    }
    state.validatedEpoch = storageEpoch;
    state.storageEpoch = storageEpoch;
    state.providerEpoch = cacheEpoch;
    this.jumpHits += 1;
    return state;
  }

  /** Hottest successors of one artifact, ordered by observed transitions. */
  hottestSuccessors(state: ArtifactState): readonly ArtifactState[] {
    const totals = new Map<ArtifactState, number>();
    for (const site of this.sites) {
      if (site.from !== state) continue;
      for (let slot = 0; slot < DISPATCH_IC_CAPACITY; slot += 1) {
        const target = site.states[slot];
        if (target === undefined) continue;
        const weight = site.counts[slot]! + 1;
        totals.set(target, (totals.get(target) ?? 0) + weight);
      }
    }
    return [...totals.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([target]) => target);
  }

  /** Aggregate IC statistics for `jitInternals`. */
  stats(): {
    readonly icHits: number;
    readonly icMisses: number;
    readonly jumpHits: number;
    readonly jumpMisses: number;
  } {
    let icHits = 0;
    let icMisses = 0;
    for (const site of this.sites) {
      icHits += site.hits;
      icMisses += site.misses;
    }
    return { icHits, icMisses, jumpHits: this.jumpHits, jumpMisses: this.jumpMisses };
  }

  #jumpCache(providerIndex: number): JumpCache | undefined {
    if (this.#providers[providerIndex] === undefined) return undefined;
    let cache = this.#jumpCaches[providerIndex];
    if (cache === undefined) {
      cache = new JumpCache();
      this.#jumpCaches[providerIndex] = cache;
    }
    return cache;
  }
}

/** Build the provider metadata table used by the dispatcher and code generation. */
export function providerDispatchInfo(
  providers: readonly {
    readonly keyTypes: readonly ScalarType[];
    readonly params: readonly ScalarType[];
    readonly results: readonly ScalarType[];
  }[],
): readonly ProviderDispatchInfo[] {
  return providers.map((provider) => ({
    keyTypes: provider.keyTypes,
    params: provider.params,
    results: provider.results,
  }));
}
