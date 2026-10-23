/**
 * Dead code elimination (DCE).
 *
 * An instruction whose results are not live and that has no storage, host or
 * transfer effect can be removed. The removal always leaves a synthetic
 * `Check` at the same position so the source step count is unchanged:
 *
 * - pure instructions become `Check(none)`;
 * - `int.div` / `int.rem` become `Check(divzero)` with the original operands;
 * - `convert.floatToInt` becomes `Check(f2i)`;
 * - `state.load` becomes `Check(none)`;
 * - `array.load` / `bytes.load` become `Check(bounds)` and still throw at the
 *   original location when the index is out of range.
 *
 * After the instruction sweep the pass also removes unreachable blocks and
 * unused block parameters (and their edge arguments).
 */
import { EFFECT_INFO } from '../effects';
import { Op } from '../mir';
import type { MBlock, MFunction, MInst, MTerm, ValueId } from '../mir';
import { analyzeCFG } from '../cfg';
import { computeLiveness, terminatorUses } from '../liveness';
import { copyTerm, isPure, makeCheck, rebuildFunction, type CheckKind } from './util';

function workBlocks(fn: MFunction): Map<number, MBlock> {
  const result = new Map<number, MBlock>();
  for (const block of fn.blocks) {
    result.set(block.id, {
      id: block.id,
      params: [...block.params],
      insts: [...block.insts],
      term: block.term,
      preds: [],
      succs: [],
    });
  }
  return result;
}

/** The `Check` that preserves an instruction's throwing behaviour, if any. */
function replacement(inst: MInst): MInst | undefined {
  if (inst.op === Op.Check || inst.op === Op.Spill) return undefined;
  // A pass may have moved the instruction (LICM uses step 0); the replacement
  // must keep that accounting rather than assuming one source step.
  const step = inst.step;
  if (inst.op === Op.StateLoad) {
    return makeCheck(inst, 'none', { step });
  }
  if (inst.op === Op.ArrayLoad || inst.op === Op.BytesLoad) {
    const kind: CheckKind = 'bounds';
    return makeCheck(inst, kind, {
      args: inst.args,
      refs: inst.refs,
      imm: inst.imm,
      step,
    });
  }
  const info = EFFECT_INFO[inst.op];
  if (info === undefined || !isPure(info)) return undefined;
  if (info.throws) {
    if (inst.op === Op.IntDiv || inst.op === Op.IntRem) {
      return makeCheck(inst, 'divzero', { args: inst.args, step });
    }
    if (inst.op === Op.ConvertFloatToInt) {
      return makeCheck(inst, 'f2i', { args: inst.args, step });
    }
    return undefined;
  }
  return makeCheck(inst, 'none', { step });
}

/** Remove unreachable blocks (deleted source blocks are allowed by verify). */
function dropUnreachable(fn: MFunction): MFunction {
  const analysis = analyzeCFG(fn);
  if (analysis.cfg.unreachable.length === 0) return fn;
  const unreachable = new Set(analysis.cfg.unreachable);
  return rebuildFunction(
    fn,
    fn.blocks.filter((block) => !unreachable.has(block.id)),
  ).fn;
}

/** One sweep over every block; returns the same function when nothing died. */
function sweep(fn: MFunction): MFunction {
  const liveness = computeLiveness(fn);
  const blocks = workBlocks(fn);
  let changed = false;
  for (const block of fn.blocks) {
    const working = blocks.get(block.id)!;
    const live = new Set<ValueId>(liveness.liveOut.get(block.id) ?? []);
    for (const value of terminatorUses(block.term)) live.add(value);
    for (let index = block.insts.length - 1; index >= 0; index -= 1) {
      const inst = block.insts[index]!;
      if (inst.op === Op.Check || inst.op === Op.Spill) {
        for (const arg of inst.args) live.add(arg);
        continue;
      }
      const unused = inst.results.every((result) => !live.has(result));
      const check = unused ? replacement(inst) : undefined;
      if (check !== undefined) {
        working.insts[index] = check;
        for (const arg of check.args) live.add(arg);
        changed = true;
        continue;
      }
      for (const result of inst.results) live.delete(result);
      for (const arg of inst.args) live.add(arg);
    }
  }
  if (!changed) return fn;
  return rebuildFunction(
    fn,
    fn.blocks.map((block) => blocks.get(block.id)!),
  ).fn;
}

function usedValues(fn: MFunction): Set<ValueId> {
  const used = new Set<ValueId>();
  for (const block of fn.blocks) {
    for (const inst of block.insts) for (const arg of inst.args) used.add(arg);
    for (const value of terminatorUses(block.term)) used.add(value);
  }
  return used;
}

function removeEdgeArguments(
  term: MTerm,
  removed: ReadonlyMap<number, ReadonlySet<number>>,
): MTerm {
  switch (term.kind) {
    case 'jump': {
      const drop = removed.get(term.target);
      return {
        kind: 'jump',
        target: term.target,
        args:
          drop === undefined
            ? [...term.args]
            : term.args.filter((_value, index) => !drop.has(index)),
        loc: term.loc,
        step: term.step,
      };
    }
    case 'branch': {
      const yesDrop = removed.get(term.yes.target);
      const noDrop = removed.get(term.no.target);
      return {
        kind: 'branch',
        cond: term.cond,
        yes: {
          target: term.yes.target,
          args:
            yesDrop === undefined
              ? [...term.yes.args]
              : term.yes.args.filter((_value, index) => !yesDrop.has(index)),
        },
        no: {
          target: term.no.target,
          args:
            noDrop === undefined
              ? [...term.no.args]
              : term.no.args.filter((_value, index) => !noDrop.has(index)),
        },
        loc: term.loc,
        step: term.step,
      };
    }
    default:
      return copyTerm(term);
  }
}

/** Drop unused block parameters until a fixed point is reached. */
function removeUnusedParams(fn: MFunction): MFunction {
  let current = fn;
  for (;;) {
    const used = usedValues(current);
    const removed = new Map<number, Set<number>>();
    for (const block of current.blocks) {
      // The entry block parameters are the function arguments; their calling
      // convention is fixed even when a parameter is unused.
      if (block.id === 0) continue;
      block.params.forEach((param, index) => {
        if (used.has(param)) return;
        let indices = removed.get(block.id);
        if (indices === undefined) {
          indices = new Set<number>();
          removed.set(block.id, indices);
        }
        indices.add(index);
      });
    }
    if (removed.size === 0) return current;

    const blocks = workBlocks(current);
    for (const block of blocks.values()) {
      const drop = removed.get(block.id);
      if (drop !== undefined) {
        block.params = block.params.filter((_param, index) => !drop.has(index));
      }
      block.term = removeEdgeArguments(block.term, removed);
    }
    current = rebuildFunction(
      current,
      current.blocks.map((block) => blocks.get(block.id)!),
    ).fn;
  }
}

export function optimizeFunction(fn: MFunction): MFunction {
  let current = dropUnreachable(fn);
  for (;;) {
    const next = sweep(current);
    if (next === current) break;
    current = next;
  }
  return removeUnusedParams(current);
}
