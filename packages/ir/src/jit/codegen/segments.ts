/**
 * Step segments and the location table (J6).
 *
 * A block is partitioned into segments at host boundaries (`call`, executors,
 * events, bridge, `checkpoint`) and at its terminator. Generated code advances
 * `rt.steps` by the whole segment on the fast path; when the remaining budget
 * cannot cover the segment it switches to an exact, per-item copy that checks
 * the budget before every step.
 *
 * `stepsAfter[loc]` is the number of segment steps that had *not* run yet when
 * an item located at `loc` threw. The runtime subtracts it from `rt.steps` to
 * reproduce the reference step count. Exact-copy items get their own location
 * ids (sharing the same source location object) with `stepsAfter = 0`.
 */
import type { IRExecutionLocation } from '../../interpreter';
import { EFFECT_INFO } from '../effects';
import type { LocId, MBlock, MFunction, MInlineFrame, MInst, MTerm } from '../mir';

/** One instruction or terminator, planned for both budget paths. */
export interface PlannedItem {
  readonly inst: MInst | undefined;
  readonly term: MTerm | undefined;
  readonly step: 0 | 1;
  /** Location used on the fast path. */
  readonly loc: LocId;
  /** Distinct location used inside the exact copy. */
  readonly exactLoc: LocId;
  /** Whether generated code must set `L` before running this item. */
  readonly throwable: boolean;
}

/** A maximal run of steps that shares one budget decision. */
export interface PlannedSegment {
  /** Last item is the terminator when `terminator` is true. */
  readonly items: readonly PlannedItem[];
  readonly steps: number;
  readonly terminator: boolean;
}

/** Per-function plan: segments by block id plus the extended location table. */
export interface FunctionPlan {
  readonly blocks: ReadonlyMap<number, readonly PlannedSegment[]>;
  readonly locations: readonly IRExecutionLocation[];
  readonly stepsAfter: Int32Array;
  /**
   * Virtual-frame chain for every location id. Exact-copy items point at the
   * original item's parent (not at the original item itself), so unwinding
   * reports each inlined frame exactly once.
   */
  readonly parent: Int32Array;
  readonly inlineFrames: readonly (MInlineFrame | undefined)[];
}

interface MutableItem {
  inst: MInst | undefined;
  term: MTerm | undefined;
  step: 0 | 1;
  loc: LocId;
  exactLoc: number;
  throwable: boolean;
}

function instructionItem(inst: MInst): MutableItem {
  return {
    inst,
    term: undefined,
    step: inst.step,
    loc: inst.loc,
    exactLoc: -1,
    throwable: EFFECT_INFO[inst.op].throws,
  };
}

function terminatorItem(term: MTerm): MutableItem {
  // Every terminator sets L: no terminator may report the preceding item's
  // location, and some terminators (trap, dispatch) call host code.
  return { inst: undefined, term, step: term.step, loc: term.loc, exactLoc: -1, throwable: true };
}

/** True when an instruction ends a segment (it enters host code). */
export function endsSegment(inst: MInst): boolean {
  return EFFECT_INFO[inst.op].host;
}

function blockSegments(block: MBlock): MutableItem[][] {
  const segments: MutableItem[][] = [];
  let current: MutableItem[] = [];
  for (const inst of block.insts) {
    current.push(instructionItem(inst));
    if (endsSegment(inst)) {
      segments.push(current);
      current = [];
    }
  }
  current.push(terminatorItem(block.term));
  segments.push(current);
  return segments;
}

/**
 * Plan every block (reachable or not); code generation only asks for blocks it
 * emits. Fills a fresh location table (the MIR table stays immutable).
 */
export function planFunction(fn: MFunction): FunctionPlan {
  const planned = new Map<number, MutableItem[][]>();
  for (const block of fn.blocks) planned.set(block.id, blockSegments(block));

  const locations = [...fn.locs.locations];
  const parent = Array.from(fn.locs.parent);
  const inlineFrames = [...fn.locs.inlineFrames];
  for (const segments of planned.values()) {
    for (const segment of segments) {
      for (const item of segment) {
        item.exactLoc = locations.length;
        locations.push(fn.locs.locations[item.loc]!);
        // Skip the duplicate: `loc` and `exactLoc` share one location object.
        parent.push(fn.locs.parent[item.loc] ?? -1);
        inlineFrames.push(fn.locs.inlineFrames[item.loc]);
      }
    }
  }

  const stepsAfter = new Int32Array(locations.length);
  const blocks = new Map<number, readonly PlannedSegment[]>();
  for (const [id, segments] of planned) {
    const result: PlannedSegment[] = [];
    for (const segment of segments) {
      let steps = 0;
      for (const item of segment) steps += item.step;
      let before = 0;
      const items: PlannedItem[] = segment.map((item) => {
        const remaining = steps - (before + item.step);
        stepsAfter[item.loc] = remaining;
        stepsAfter[item.exactLoc] = 0;
        before += item.step;
        return {
          inst: item.inst,
          term: item.term,
          step: item.step,
          loc: item.loc,
          exactLoc: item.exactLoc,
          throwable: item.throwable,
        };
      });
      result.push({
        items,
        steps,
        terminator: segment[segment.length - 1]!.term !== undefined,
      });
    }
    blocks.set(id, result);
  }
  return { blocks, locations, stepsAfter, parent: Int32Array.from(parent), inlineFrames };
}
