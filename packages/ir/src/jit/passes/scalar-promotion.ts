/**
 * Scalar promotion of state resources and constant array elements (J12,
 * `scalarPromotion`).
 *
 * A location is promoted when the function accesses it at least twice and at
 * least one access sits inside a loop. Each promoted location gets one local
 * (`p<id>`) plus a dirty flag (`p<id>d`); the backing view is only touched at
 * the function entry, before/after a barrier (host code, call, checkpoint,
 * return, dispatch) and in the generated `catch` block.
 *
 * ## Why the storage contents stay identical (C5)
 *
 * 1. Host code can only observe storage at a barrier. Every barrier writes the
 *    dirty locals back before entering host code, so the host sees exactly the
 *    bytes the reference would have written.
 * 2. Version units only become observable at a host point or when `execute`
 *    ends; both happen after a writeback. Skipping the intermediate advances
 *    only avoids creating internal tokens (C12): every token captured before
 *    the stores is invalidated by the single advance performed at writeback.
 *    As in the reference, a write always advances at least once.
 * 3. `record.tracked()` can only flip from false to true in provider
 *    generation, which is a barrier; the check at writeback therefore matches
 *    what the store would have observed.
 * 4. An error exit writes back the values of all stores that had already run,
 *    exactly like the reference (which wrote them at their original position).
 *
 * A `state.store` / `array.store` keeps its original position for the
 * suspended-write check: when `ctl.suspended !== 0` code generation calls the
 * public storage method, which throws `unauthorized-resource` with the same
 * location and step count.
 */
import { analyzeCFG } from '../cfg';
import { Op } from '../mir';
import type { MFunction, MInst, MPromotion, ValueId } from '../mir';
import { analyzeRepresentation } from '../repr';
import { constantNumber, isFullBarrier, promotionIds, scalarLayout } from './memory-model';
import type { MemoryPassContext } from './memory-model';

interface Access {
  readonly block: number;
  readonly inst: MInst;
  readonly kind: 'load' | 'store';
  readonly memory: number;
  readonly index: number | undefined;
  readonly inLoop: boolean;
}

interface Candidate {
  readonly key: string;
  readonly memory: number;
  readonly index: number | undefined;
  readonly type: MPromotion['type'];
  count: number;
  stores: number;
  inLoop: boolean;
}

function accessKey(memory: number, index: number | undefined): string {
  return index === undefined ? `s:${memory}` : `a:${memory}:${index}`;
}

function makePromotionOp(
  op: Op.PromoteReload | Op.Spill,
  ids: readonly number[],
  loc: number,
): MInst {
  return {
    op,
    args: [],
    results: [],
    imm: [],
    refs: [...ids],
    node: undefined,
    loc,
    step: 0,
  };
}

function collectAccesses(
  fn: MFunction,
  context: MemoryPassContext,
  loopBlocks: ReadonlySet<number>,
): Access[] {
  const accesses: Access[] = [];
  for (const block of fn.blocks) {
    const inLoop = loopBlocks.has(block.id);
    for (const inst of block.insts) {
      let kind: 'load' | 'store';
      let index: number | undefined;
      switch (inst.op) {
        case Op.StateLoad:
          kind = 'load';
          index = undefined;
          break;
        case Op.StateStore:
          kind = 'store';
          index = undefined;
          break;
        case Op.ArrayLoad:
          kind = 'load';
          index = constantNumber(fn, inst.args[0]!);
          break;
        case Op.ArrayStore:
          kind = 'store';
          index = constantNumber(fn, inst.args[0]!);
          break;
        default:
          continue;
      }
      const memory = inst.refs[0]!;
      // Only scalar `state` and constant-indexed `array` elements are candidates.
      if (inst.op === Op.StateLoad || inst.op === Op.StateStore) {
        if (scalarLayout(context, memory, 'state') === undefined) continue;
      } else {
        if (scalarLayout(context, memory, 'array') === undefined) continue;
        if (index === undefined) continue;
      }
      accesses.push({ block: block.id, inst, kind, memory, index, inLoop });
    }
  }
  return accesses;
}

function selectPromotions(
  fn: MFunction,
  context: MemoryPassContext,
  accesses: readonly Access[],
): { promotions: MPromotion[]; locations: Map<string, number> } {
  const candidates = new Map<string, Candidate>();
  for (const access of accesses) {
    const key = accessKey(access.memory, access.index);
    let candidate = candidates.get(key);
    if (candidate === undefined) {
      const layout =
        access.index === undefined
          ? scalarLayout(context, access.memory, 'state')
          : scalarLayout(context, access.memory, 'array');
      if (layout === undefined) continue;
      if (access.index !== undefined && (access.index < 0 || access.index >= layout.length)) {
        continue;
      }
      candidate = {
        key,
        memory: access.memory,
        index: access.index,
        type: layout.scalarType,
        count: 0,
        stores: 0,
        inLoop: false,
      };
      candidates.set(key, candidate);
    }
    candidate.count += 1;
    if (access.kind === 'store') candidate.stores += 1;
    candidate.inLoop ||= access.inLoop;
  }

  const promotions: MPromotion[] = [];
  const locations = new Map<string, number>();
  const ordered = [...candidates.values()]
    .filter((candidate) => candidate.count >= 2 && candidate.inLoop)
    .sort((left, right) => left.memory - right.memory || (left.index ?? -1) - (right.index ?? -1));
  for (const candidate of ordered) {
    // A store to a read-only resource must keep throwing at its original spot.
    if (candidate.stores > 0 && context.memories[candidate.memory]?.writable !== true) {
      continue;
    }
    const id = promotions.length;
    promotions.push({
      id,
      memory: candidate.memory,
      index: candidate.index,
      type: candidate.type,
    });
    locations.set(candidate.key, id);
  }
  return { promotions, locations };
}

function rewriteAccesses(fn: MFunction, locations: ReadonlyMap<string, number>): number {
  let rewritten = 0;
  for (const block of fn.blocks) {
    block.insts = block.insts.map((inst) => {
      let key: string | undefined;
      let valueId: ValueId | undefined;
      switch (inst.op) {
        case Op.StateLoad:
          key = accessKey(inst.refs[0]!, undefined);
          break;
        case Op.StateStore:
          key = accessKey(inst.refs[0]!, undefined);
          valueId = inst.args[0];
          break;
        case Op.ArrayLoad: {
          const index = constantNumber(fn, inst.args[0]!);
          if (index === undefined) return inst;
          key = accessKey(inst.refs[0]!, index);
          break;
        }
        case Op.ArrayStore: {
          const index = constantNumber(fn, inst.args[0]!);
          if (index === undefined) return inst;
          key = accessKey(inst.refs[0]!, index);
          valueId = inst.args[1];
          break;
        }
        default:
          return inst;
      }
      const id = locations.get(key);
      if (id === undefined) return inst;
      if (inst.op === Op.StateLoad || inst.op === Op.ArrayLoad) {
        rewritten += 1;
        const replacement: MInst = {
          op: Op.PromoteLoad,
          args: [],
          results: [...inst.results],
          imm: [],
          refs: [id],
          node: inst.node,
          loc: inst.loc,
          step: inst.step,
        };
        for (const result of replacement.results) fn.values[result]!.def = replacement;
        return replacement;
      }
      if (valueId === undefined) return inst;
      rewritten += 1;
      return {
        op: Op.PromoteStore,
        args: [valueId],
        results: [],
        imm: [],
        refs: [id],
        node: inst.node,
        loc: inst.loc,
        step: inst.step,
      };
    });
  }
  return rewritten;
}

/**
 * Classify a non-promotion instruction as an aliasing barrier.
 *
 * Only array accesses can alias another (scalar) location: an unknown index may
 * hit a promoted element, while a different constant index cannot. Byte
 * resources and state resources never alias an array element.
 */
function aliasBarrier(
  fn: MFunction,
  inst: MInst,
  promotedArrays: ReadonlyMap<number, ReadonlySet<number>>,
): { spill: boolean; reload: boolean } {
  if (inst.op !== Op.ArrayLoad && inst.op !== Op.ArrayStore) {
    return { spill: false, reload: false };
  }
  const memory = inst.refs[0]!;
  const indexes = promotedArrays.get(memory);
  if (indexes === undefined) return { spill: false, reload: false };
  const index = constantNumber(fn, inst.args[0]!);
  if (index !== undefined && !indexes.has(index)) {
    return { spill: false, reload: false };
  }
  return { spill: true, reload: inst.op === Op.ArrayStore };
}

/**
 * Promote hot storage locations on one function. Returns the number of
 * locations promoted (0 leaves the function untouched).
 */
export function runScalarPromotion(fn: MFunction, context: MemoryPassContext): number {
  if (fn.promotions.length > 0) return 0;
  // Store forwarding in codegen depends on knowing whether a float is `U`.
  analyzeRepresentation(fn);
  const analysis = analyzeCFG(fn);
  const loopBlocks = new Set<number>();
  for (const loop of analysis.loops) {
    for (const block of loop.blocks) loopBlocks.add(block);
  }
  if (loopBlocks.size === 0) return 0;

  const accesses = collectAccesses(fn, context, loopBlocks);
  const { promotions, locations } = selectPromotions(fn, context, accesses);
  if (promotions.length === 0) return 0;

  rewriteAccesses(fn, locations);
  fn.promotions = promotions;
  const ids = promotionIds(fn);

  const promotedArrays = new Map<number, Set<number>>();
  for (const promotion of promotions) {
    if (promotion.index === undefined) continue;
    let set = promotedArrays.get(promotion.memory);
    if (set === undefined) {
      set = new Set();
      promotedArrays.set(promotion.memory, set);
    }
    set.add(promotion.index);
  }

  for (const block of fn.blocks) {
    const next: MInst[] = [];
    for (const inst of block.insts) {
      if (
        inst.op === Op.PromoteLoad ||
        inst.op === Op.PromoteStore ||
        inst.op === Op.PromoteReload ||
        inst.op === Op.Spill
      ) {
        next.push(inst);
        continue;
      }
      const full = isFullBarrier(inst);
      const alias = full ? { spill: false, reload: false } : aliasBarrier(fn, inst, promotedArrays);
      const spill = full || alias.spill;
      const reload = full || alias.reload;
      if (spill) next.push(makePromotionOp(Op.Spill, ids, inst.loc));
      next.push(inst);
      if (reload) next.push(makePromotionOp(Op.PromoteReload, ids, inst.loc));
    }
    if (block.term.kind === 'return' || block.term.kind === 'dispatch') {
      next.push(makePromotionOp(Op.Spill, ids, block.term.loc));
    }
    block.insts = next;
  }

  // The locals are initialized from the backing view by the function
  // prologue (not by an entry instruction): the entry block can itself be a
  // loop header, where an instruction would re-read storage every iteration.
  return promotions.length;
}

/** Exposed for tests: the location key of a promotion-shaped access. */
export function promotionAccessKey(memory: number, index: number | undefined): string {
  return accessKey(memory, index);
}

/** Exposed for tests: instruction classification helper. */
export function isPromotionInstruction(inst: MInst): boolean {
  return (
    inst.op === Op.PromoteLoad ||
    inst.op === Op.PromoteStore ||
    inst.op === Op.PromoteReload ||
    inst.op === Op.Spill
  );
}
