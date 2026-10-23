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
 */
import type { ArtifactState, DispatchKey, DispatchRegistry, RegionHandle } from './dispatch-ic';
import { MAX_REGION_MEMBERS } from './dispatch-ic';
import { Op } from './mir';
import type { MFunction } from './mir';
import type { ScalarType } from '../types';

/** Runtime state referenced by generated region code (`RS.*`). */
export interface RegionRuntimeState {
  readonly states: readonly ArtifactState[];
  readonly keys: readonly (readonly DispatchKey[])[];
  /** Per-member storage epoch recorded after the last validated entry. */
  readonly es: number[];
  /** Per-member provider cache epoch. */
  readonly cs: number[];
  /** Artifact function indices, used by the deep-recursion fallback. */
  readonly ids: readonly number[];
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
}

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
  readonly type: ScalarType;
}

/**
 * Select the state resources that are worth keeping in region locals.
 *
 * Every `state.load` / `state.store` in every member counts as one access;
 * locations accessed at least twice become shared locals. State resources
 * cannot alias byte/array memories, so the promotion is sound without an
 * alias analysis. Constant-index array elements are deliberately left out:
 * they can alias other array accesses in another member.
 */
export function collectRegionPromotions(
  members: readonly RegionMember[],
): readonly RegionPromotion[] {
  const counts = new Map<number, { count: number; type: ScalarType }>();
  for (const member of members) {
    for (const block of member.mir.blocks) {
      for (const inst of block.insts) {
        let memory: number | undefined;
        let type: ScalarType | undefined;
        if (inst.op === Op.StateLoad) {
          memory = inst.refs[0];
          const result = inst.results[0];
          type = result === undefined ? undefined : member.mir.values[result]?.type;
        } else if (inst.op === Op.StateStore) {
          memory = inst.refs[0];
          const value = inst.args[0];
          type = value === undefined ? undefined : member.mir.values[value]?.type;
        } else {
          continue;
        }
        if (memory === undefined || type === undefined) continue;
        const entry = counts.get(memory);
        if (entry === undefined) counts.set(memory, { count: 1, type });
        else entry.count += 1;
      }
    }
  }
  return [...counts.entries()]
    .filter(([, entry]) => entry.count >= 2)
    .sort(([left], [right]) => left - right)
    .map(([memory, entry], id) => ({ id, memory, type: entry.type }));
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
export function createRegionRuntime(members: readonly RegionMember[]): RegionRuntimeState {
  return {
    states: members.map((member) => member.state),
    keys: members.map((member) => member.key),
    // The artifact's recorded epochs maximise first-jump hits; a changed epoch
    // simply sends the dispatch through the generic materialize path.
    es: members.map((member) => member.state.storageEpoch),
    cs: members.map((member) => member.state.providerEpoch),
    ids: members.map((member) => member.state.artifact.index),
  };
}

/** Register a compiled region on every member. Returns the region index table. */
export function attachRegion(region: CompiledRegion): void {
  region.members.forEach((state, index) => {
    state.region = region;
    state.regionIndex = index;
  });
}
