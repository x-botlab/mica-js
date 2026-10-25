/**
 * Hot dispatch-chain regions (J14).
 *
 * A region is a set of hot provider artifacts of one provider that the engine
 * compiles into a *single* JavaScript function. The function is a small state
 * machine:
 *
 * ```js
 * return function region7(entryIndex, a0, a1 /* union of member params *\/) {
 *   let cur = entryIndex;
 *   for (;;) {
 *     switch (cur) {
 *       case 0: /* member 0 body *\/
 *       case 1: /* member 1 body *\/
 *     }
 *   }
 * };
 * ```
 *
 * A dispatch inside a member that targets another member (`cur = j; continue`)
 * is not a host boundary: no `beforeHost` / `materialize` / `afterHost` runs,
 * so the transfer is unobservable (lemma L). Every other dispatch exits the
 * region through the usual `TAIL` protocol after the generic materialize path.
 * A self-dispatch therefore becomes a plain JavaScript loop, and cross-block
 * jumps become variable assignments plus `continue`.
 *
 * Members are collected from the IC transition counts: start at the artifact
 * that reached {@link REGION_THRESHOLD} entries and walk depth-first along the
 * hottest successor first. Only already compiled artifacts of the same
 * provider become members; at most {@link MAX_REGION_MEMBERS} are collected.
 * Regions are cached by member set and never evicted. A regenerated artifact
 * is a fresh object, so it is never a member of the old region and the entry
 * check selects the normal dispatch path again.
 *
 * J15 removes that round trip for region-to-region transfers. Two mechanisms
 * share the same idea — the transfer names its target region instead of going
 * back through the driver — and both fall back to `TAIL` whenever anything is
 * uncertain:
 *
 * - the *inline tail* continues a jump-cache hit inside the region that owns
 *   the resolved artifact (`handle.fn(state.regionIndex, ...)`), which needs no
 *   profile and covers every crossing;
 * - a *direct-call guard* short-circuits the jump-cache probe for the hottest
 *   exits of the region. The engine profiles the exit targets, and once one is
 *   hot enough the region is recompiled with a literal key + epoch guard for
 *   its top targets. The guard fails closed: any changed epoch, unbounded
 *   nesting, or recompiled callee sends the transfer down the generic
 *   `materialize` path.
 *
 * Because a direct call keeps the caller's JavaScript frame alive, both
 * mechanisms stop at {@link REGION_DIRECT_CALL_DEPTH} and hand the transfer
 * back to the trampoline, which keeps the stack flat and bounded.
 */
import type { ArtifactState, DispatchKey, DispatchRegistry, RegionHandle } from './dispatch-ic';
import { MAX_REGION_MEMBERS } from './dispatch-ic';
import { Op } from './mir';
import type { MFunction } from './mir';
import { constantNumber, NUMERIC_BYTES } from './passes/memory-model';
import type { MemoryDefinition, NumericType, ScalarType } from '../types';

/** Runtime state referenced by generated region code (`RS.*`). */
export interface RegionRuntimeState {
  /** Region identity, shared with the inter-region dependency graph (J15). */
  readonly key: string;
  readonly states: readonly ArtifactState[];
  readonly keys: readonly (readonly DispatchKey[])[];
  /** Per-member storage epoch recorded after the last validated entry. */
  readonly es: number[];
  /** Per-member provider cache epoch. */
  readonly cs: number[];
  /** Artifact function indices, used by the deep-recursion fallback. */
  readonly ids: readonly number[];
  /**
   * Exit-target profile (J15). Generated code only reports while
   * {@link RegionExitProfile.budget} is positive; the engine owns the counters
   * and decides when the region is recompiled with direct calls.
   */
  readonly profile: RegionExitProfile;
}

/** One artifact selected for region compilation. */
export interface RegionMember {
  readonly state: ArtifactState;
  readonly mir: MFunction;
  readonly key: readonly DispatchKey[];
  readonly keyTypes: readonly ScalarType[];
  readonly params: readonly ScalarType[];
  readonly providerIndex: number;
}

/** A compiled region: the callable plus the member states it owns. */
export interface CompiledRegion extends RegionHandle {
  readonly source: string;
  readonly members: readonly ArtifactState[];
  /** Runtime epoch/key/profile table referenced by the generated code. */
  readonly runtime: RegionRuntimeState;
  /**
   * Regions this compilation directly calls, one record per emitted guard
   * (J15). The engine keeps a reverse graph over these keys so recompiling a
   * callee refreshes every caller.
   */
  readonly directCallDeps: readonly RegionDirectCallDep[];
}

/** One inter-region call emitted into a compiled region (J15). */
export interface RegionDirectCallDep {
  /** Key of the callee region (`regionKeyOf`). */
  readonly key: string;
  /** Storage epoch literal guarding the call. */
  readonly epoch: number;
}

/** One sampled exit target and how often it was observed. */
export interface RegionExitSlot {
  readonly state: ArtifactState;
  count: number;
}

/**
 * Exit-target profile of one region (J15).
 *
 * Generated region code reports the artifact every exit transferred to. The
 * engine turns the hottest targets that belong to another compiled region into
 * direct calls once a target crosses
 * {@link REGION_DIRECT_CALL_THRESHOLD}; the budget bounds the sampling cost so
 * a region whose exits never qualify stops paying for the report.
 */
export interface RegionExitProfile {
  readonly slots: RegionExitSlot[];
  /** Remaining exit reports; `0` disables sampling in generated code. */
  budget: number;
  /** Set while a rebuild is pending, so one window requests one rebuild. */
  requested: boolean;
}

/** Sampled exit targets per region before new ones are ignored. */
export const REGION_PROFILE_SLOTS = 8;

/** Exits a region reports before sampling stops. */
export const REGION_PROFILE_BUDGET = 16_384;

/** Observations of one target before the region is recompiled (J15). */
export const REGION_DIRECT_CALL_THRESHOLD = 256;

/** Direct calls emitted into one region (`top-4` exit targets). */
export const MAX_REGION_DIRECT_CALLS = 4;

/** Recompilations one region may go through before it keeps its plan. */
export const MAX_REGION_REBUILDS = 2;

/**
 * Maximum nesting of direct region calls.
 *
 * A direct call keeps the caller's JavaScript frame alive, so a ring of regions
 * would grow the stack without bound; `rt.maxDepth` only guards IR recursion
 * and sits far above what the host stack can hold. Past this depth the exit
 * returns `TAIL` instead, which unwinds to the driver loop and restarts the
 * chain. The value stays well inside a default V8 stack for a generated region
 * function (which declares a large local frame).
 */
export const REGION_DIRECT_CALL_DEPTH = 8;

/**
 * One state location promoted to a region-wide local (J14).
 *
 * Unlike the per-function promotion of #152, the local is shared by every
 * member: a value written by one block is visible to the next without a
 * storage round trip. Dirty values are written back before any host boundary
 * and when the region exits.
 */
export interface RegionPromotion {
  readonly id: number;
  readonly memory: number;
  /** Constant array index for an element promotion; `undefined` for a state slot. */
  readonly index?: number;
  /** Constant byte interval for a `bytes` promotion; `undefined` otherwise. */
  readonly bytes?: {
    readonly offset: number;
    readonly numeric: NumericType;
    readonly little: boolean;
  };
  readonly type: ScalarType;
}

interface PromotionCandidate {
  count: number;
  type: ScalarType;
  /** True when some access stores to the location. */
  stores: boolean;
}

/** Identity of one constant byte interval inside a `bytes` memory. */
interface IntervalKey {
  readonly offset: number;
  readonly numeric: NumericType;
  readonly little: boolean;
}

function countCandidate(
  counts: Map<number, PromotionCandidate>,
  memory: number,
  type: ScalarType,
  store: boolean,
): void {
  const entry = counts.get(memory);
  if (entry === undefined) counts.set(memory, { count: 1, type, stores: store });
  else {
    entry.count += 1;
    entry.stores ||= store;
  }
}

/**
 * Select the state resources that are worth keeping in region locals.
 *
 * Every `state.load` / `state.store` in every member counts as one access, and
 * a member-local scalar promotion of a state slot counts as an access too: that
 * slot must resolve to the same region-wide local in every member, otherwise
 * two members would cache one location independently. Locations accessed at
 * least twice become shared locals. State resources cannot alias byte/array
 * memories, so the promotion is sound without an alias analysis.
 *
 * Constant-index array elements are promoted on the same terms when the memory
 * is *closed* inside the region: every access to it in every member must be a
 * constant index. A dynamic access would alias any element, so such a memory
 * stays in storage. This is what keeps a translated register file in locals: a
 * guest basic block that reads and writes `registers[1]` is one artifact, and
 * the loop that repeats it exists only after fusion, so the per-artifact
 * promotion pass cannot see the reuse.
 *
 * `bytes` resources are promoted the same way, one constant interval at a time
 * (this is what keeps the GPIO ODR/DIR read-modify-write out of the guest
 * loop). A resource with a dynamic byte access, an overlapping pair of constant
 * intervals, a float interval or a range copy/fill is left entirely in storage.
 *
 * `memories` supplies the array length, byte length and writability. Without
 * it, element and interval promotion are disabled (state-only behaviour).
 */
export function collectRegionPromotions(
  members: readonly RegionMember[],
  memories?: readonly MemoryDefinition[],
): readonly RegionPromotion[] {
  const scalars = new Map<number, PromotionCandidate>();
  const elements = new Map<number, Map<number, PromotionCandidate>>();
  /** Byte intervals keyed by `${offset}:${numeric}:${little}` inside one memory. */
  const intervals = new Map<number, Map<string, PromotionCandidate & { key: IntervalKey }>>();
  /** Array memories with an access the region cannot name: never promote them. */
  const open = new Set<number>();
  const intervalKey = (offset: number, numeric: NumericType, little: boolean): IntervalKey => ({
    offset,
    numeric,
    little,
  });
  const intervalCount = (
    memory: number,
  ): Map<string, PromotionCandidate & { key: IntervalKey }> => {
    let hosted = intervals.get(memory);
    if (hosted === undefined) {
      hosted = new Map();
      intervals.set(memory, hosted);
    }
    return hosted;
  };
  const elementCount = (memory: number): Map<number, PromotionCandidate> => {
    let byIndex = elements.get(memory);
    if (byIndex === undefined) {
      byIndex = new Map();
      elements.set(memory, byIndex);
    }
    return byIndex;
  };
  for (const member of members) {
    const fn = member.mir;
    for (const block of fn.blocks) {
      for (const inst of block.insts) {
        if (inst.op === Op.StateLoad || inst.op === Op.StateStore) {
          const memory = inst.refs[0]!;
          const value = inst.op === Op.StateStore ? inst.args[0] : inst.results[0];
          const type = value === undefined ? undefined : fn.values[value]?.type;
          if (type === undefined) continue;
          countCandidate(scalars, memory, type, inst.op === Op.StateStore);
          continue;
        }
        if (inst.op === Op.PromoteLoad || inst.op === Op.PromoteStore) {
          const promotion = fn.promotions[inst.refs[0]!];
          if (promotion === undefined) continue;
          if (promotion.index === undefined) {
            countCandidate(scalars, promotion.memory, promotion.type, inst.op === Op.PromoteStore);
          } else {
            countCandidate(
              elementCount(promotion.memory),
              promotion.index,
              promotion.type,
              inst.op === Op.PromoteStore,
            );
          }
          continue;
        }
        if (inst.op === Op.ArrayLoad || inst.op === Op.ArrayStore) {
          const memory = inst.refs[0]!;
          const index = constantNumber(fn, inst.args[0]!);
          const value = inst.op === Op.ArrayStore ? inst.args[1] : inst.results[0];
          const type = value === undefined ? undefined : fn.values[value]?.type;
          if (index === undefined || type === undefined) {
            open.add(memory);
            continue;
          }
          countCandidate(elementCount(memory), index, type, inst.op === Op.ArrayStore);
          continue;
        }
        if (inst.op === Op.BytesLoad || inst.op === Op.BytesStore) {
          const memory = inst.refs[0]!;
          const numeric = inst.imm[0] as NumericType;
          const little = inst.imm[1] === 'little';
          const offset = constantNumber(fn, inst.args[0]!);
          // Float intervals are left alone: a `U` bit pattern does not survive
          // a storage round trip, so a promoted copy could differ from storage.
          if (offset === undefined || numeric === 'f32' || numeric === 'f64') {
            open.add(memory);
            continue;
          }
          const key = intervalKey(offset, numeric, little);
          const id = `${key.offset}:${key.numeric}:${key.little ? 1 : 0}`;
          const hosted = intervalCount(memory);
          const entry = hosted.get(id);
          if (entry === undefined) {
            hosted.set(id, { count: 1, type: numeric, stores: inst.op === Op.BytesStore, key });
          } else {
            entry.count += 1;
            entry.stores ||= inst.op === Op.BytesStore;
          }
          continue;
        }
        if (
          inst.op === Op.BytesCopy ||
          inst.op === Op.ResourceUpdateBytes ||
          inst.op === Op.ResourceFillBytes
        ) {
          // A range copy/fill names an arbitrary interval of the resource, so
          // no constant interval of it can be kept in a local.
          for (const memory of inst.refs) open.add(memory);
        }
      }
    }
  }

  const promotions: RegionPromotion[] = [];
  for (const [memory, entry] of [...scalars.entries()].sort(([left], [right]) => left - right)) {
    if (entry.count < 2) continue;
    promotions.push({ id: promotions.length, memory, type: entry.type });
  }
  for (const memory of [...elements.keys()].sort((left, right) => left - right)) {
    if (open.has(memory)) continue;
    const definition = memories?.[memory];
    if (definition === undefined || definition.kind !== 'array') continue;
    if (definition.layout.kind !== 'scalar') continue;
    const length = definition.layout.length;
    const byIndex = elements.get(memory)!;
    for (const index of [...byIndex.keys()].sort((left, right) => left - right)) {
      const entry = byIndex.get(index)!;
      if (entry.count < 2) continue;
      // An out-of-range element access must keep throwing/trapping at its
      // original spot, and a store needs a writable resource.
      if (index < 0 || index >= length) continue;
      if (entry.stores && definition.writable !== true) continue;
      promotions.push({
        id: promotions.length,
        memory,
        index,
        type: definition.layout.scalarType,
      });
    }
  }
  for (const memory of [...intervals.keys()].sort((left, right) => left - right)) {
    if (open.has(memory)) continue;
    const definition = memories?.[memory];
    if (definition === undefined || definition.layout.kind !== 'bytes') continue;
    const length = definition.layout.length;
    // Two different constant intervals of the same resource may overlap (a
    // `u32` store followed by a `u8` load of one of its bytes); a local copy of
    // each would then disagree. Such a resource stays in storage entirely.
    const keys = [...intervals.get(memory)!.values()].map((entry) => entry.key);
    const overlapping = keys.some((left, index) =>
      keys.some(
        (right, position) =>
          position > index &&
          left.offset < right.offset + NUMERIC_BYTES[right.numeric] &&
          right.offset < left.offset + NUMERIC_BYTES[left.numeric],
      ),
    );
    if (overlapping) continue;
    for (const entry of intervals.get(memory)!.values()) {
      if (entry.count < 2) continue;
      const width = NUMERIC_BYTES[entry.key.numeric];
      if (entry.key.offset < 0 || entry.key.offset + width > length) continue;
      if (entry.stores && definition.writable !== true) continue;
      promotions.push({
        id: promotions.length,
        memory,
        bytes: entry.key,
        type: entry.key.numeric,
      });
    }
  }
  return promotions;
}

/**
 * Collect the members of a region rooted at `entry`.
 *
 * The traversal is a depth-first walk over {@link DispatchRegistry}'s
 * per-site transition counts, hottest successor first. A member is eligible
 * only when it belongs to the same provider and has already been compiled;
 * this keeps the region closed under the transitions it can absorb.
 */
export function collectRegionMembers(
  entry: ArtifactState,
  registry: DispatchRegistry,
): ArtifactState[] {
  // A keyless provider has exactly one cache slot: every dispatch would match
  // the same key, so selecting among several generations would be ambiguous.
  // A single-member region still removes the trampoline for a self-loop.
  if (entry.key.length === 0) return [entry];
  const members: ArtifactState[] = [];
  const seen = new Set<ArtifactState>();
  // A stack keeps the traversal iterative: artifacts can form cycles, and a
  // recursive walk would rely on the region size bound to terminate.
  const stack: ArtifactState[] = [entry];
  while (stack.length > 0 && members.length < MAX_REGION_MEMBERS) {
    const state = stack.pop()!;
    if (seen.has(state)) continue;
    if (state.providerIndex !== entry.providerIndex) continue;
    seen.add(state);
    members.push(state);
    const successors = registry.hottestSuccessors(state);
    // Push hottest last so it is popped (and therefore visited) first.
    for (let index = successors.length - 1; index >= 0; index -= 1) {
      const successor = successors[index]!;
      if (!seen.has(successor)) stack.push(successor);
    }
  }
  return members;
}

/** Build the mutable epoch table shared with generated region code. */
export function createRegionRuntime(
  members: readonly RegionMember[],
  options: { readonly key: string; readonly profile: RegionExitProfile },
): RegionRuntimeState {
  return {
    key: options.key,
    states: members.map((member) => member.state),
    keys: members.map((member) => member.key),
    // The artifact's recorded epochs maximise first-jump hits; a changed epoch
    // simply sends the dispatch through the generic materialize path.
    es: members.map((member) => member.state.storageEpoch),
    cs: members.map((member) => member.state.providerEpoch),
    ids: members.map((member) => member.state.artifact.index),
    profile: options.profile,
  };
}

/**
 * Identity of one region: its provider plus the sorted artifact indices of its
 * members. Recompiling the same members keeps the key, which lets the
 * inter-region dependency graph survive refreshes.
 */
export function regionKeyOf(providerIndex: number, members: readonly ArtifactState[]): string {
  const indices = members.map((member) => member.artifact.index);
  indices.sort((left, right) => left - right);
  return `${providerIndex}#${indices.join('.')}`;
}

/** A fresh, enabled exit profile. */
export function createRegionExitProfile(): RegionExitProfile {
  return { slots: [], budget: REGION_PROFILE_BUDGET, requested: false };
}

/**
 * Record one region-to-region exit. Returns true when a sampled target has
 * reached {@link REGION_DIRECT_CALL_THRESHOLD}, which asks the engine to
 * recompile the region with direct calls for its hottest exits.
 *
 * Sampling is identity based: the slot table is tiny (one entry per distinct
 * exit target) and counts saturate at twice the threshold, so a long-running
 * region never grows the table or the counters.
 */
export function recordRegionExit(profile: RegionExitProfile, state: ArtifactState): boolean {
  if (profile.budget <= 0 || profile.requested) return false;
  profile.budget -= 1;
  for (const slot of profile.slots) {
    if (slot.state !== state) continue;
    if (slot.count < REGION_DIRECT_CALL_THRESHOLD * 2) slot.count += 1;
    return slot.count >= REGION_DIRECT_CALL_THRESHOLD;
  }
  if (profile.slots.length < REGION_PROFILE_SLOTS) profile.slots.push({ state, count: 1 });
  return false;
}

/** Drop every sample once a rebuild consumed them. */
export function resetRegionExitProfile(profile: RegionExitProfile): void {
  profile.slots.length = 0;
  profile.budget = REGION_PROFILE_BUDGET;
  profile.requested = false;
}

/** Register a compiled region on every member. Returns the region index table. */
export function attachRegion(region: CompiledRegion): void {
  region.members.forEach((state, index) => {
    state.region = region;
    state.regionIndex = index;
  });
}
