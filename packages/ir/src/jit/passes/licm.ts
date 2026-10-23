/**
 * Loop-invariant code motion (LICM).
 *
 * Each natural loop is handled innermost-first. The pass hoists only pure,
 * non-throwing instructions (`const` included) whose operands are defined
 * outside the loop or were hoisted before them. The original position keeps an
 * empty `Check` with `step = 1`; the hoisted copy has `step = 0`, so moving an
 * instruction never changes the reference step count.
 *
 * The hoist target is the loop's unique outside predecessor — the natural
 * preheader. If the header has several outside predecessors, a new block would
 * be required; that case is left unchanged so no synthetic terminator (which
 * would otherwise add a step) is introduced.
 */
import { EFFECT_INFO } from '../effects';
import { Op } from '../mir';
import type { MBlock, MFunction, MInst, MValue, MTerm, ValueId } from '../mir';
import { analyzeCFG } from '../cfg';
import type { CFG, Loop } from '../cfg';
import {
  copyEdge,
  copyInst,
  copyTerm,
  definitionBlocks,
  freshBlockId,
  isPure,
  makeCheck,
  rebuildFunction,
  terminatorEdges,
} from './util';

/** Loop selection order: deepest first, then the earlier header. */
function candidates(loops: readonly Loop[], processed: ReadonlySet<number>): Loop[] {
  return loops
    .filter((loop) => !processed.has(loop.header))
    .sort((left, right) => right.depth - left.depth || left.header - right.header);
}

function hoistable(inst: MInst): boolean {
  if (inst.step !== 1) return false;
  if (inst.results.length !== 1) return false;
  if (inst.op === Op.Check || inst.op === Op.Spill || inst.op === Op.Call) return false;
  const info = EFFECT_INFO[inst.op];
  return info !== undefined && isPure(info) && !info.throws;
}

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

function hoistLoop(fn: MFunction, loop: Loop, cfg: CFG): MFunction {
  const definition = definitionBlocks(fn);
  const outside = (cfg.preds.get(loop.header) ?? []).filter((id) => !loop.blocks.has(id));
  if (outside.length === 0) return fn;
  const blocks = workBlocks(fn);

  const hoisted = new Set<number>();
  const moved: MInst[] = [];
  let changed = false;
  // Iterate to a fixed point: an instruction can become invariant only after
  // the instruction that defines its operand has been hoisted.
  for (let progress = true; progress;) {
    progress = false;
    for (const block of fn.blocks) {
      if (!loop.blocks.has(block.id)) continue;
      const working = blocks.get(block.id)!;
      working.insts.forEach((inst, index) => {
        if (!hoistable(inst)) return;
        let invariant = true;
        for (const arg of inst.args) {
          const defined = definition.get(arg);
          if (defined === undefined) continue;
          if (loop.blocks.has(defined) && !hoisted.has(arg)) {
            invariant = false;
            break;
          }
        }
        if (!invariant) return;
        // Empty check keeps the step at the original position (S-2).
        working.insts[index] = makeCheck(inst, 'none');
        moved.push(copyInst(inst, { step: 0 }));
        hoisted.add(inst.results[0]!);
        changed = true;
        progress = true;
      });
    }
  }
  if (!changed) return fn;

  // Reuse a dedicated preheader when the header has exactly one outside
  // predecessor that only jumps to it. Otherwise create one: its parameters
  // receive the original edge arguments and its jump (step 0) enters the loop.
  const outsideBlocks = outside.map((id) => fn.blocks.find((block) => block.id === id)!);
  const dedicated = outsideBlocks.length === 1 ? outsideBlocks[0] : undefined;
  const dedicatedEdges = dedicated === undefined ? [] : terminatorEdges(dedicated.term);
  let inserted: MBlock | undefined;
  let values: MValue[] = fn.values;
  let locs = fn.locs;

  if (
    dedicated !== undefined &&
    dedicatedEdges.length === 1 &&
    dedicatedEdges[0]!.target === loop.header
  ) {
    const target = blocks.get(dedicated.id)!;
    target.insts = [...target.insts, ...moved];
  } else {
    const header = fn.blocks.find((block) => block.id === loop.header)!;
    const id = freshBlockId(fn);
    const base = fn.values.length;
    const params: ValueId[] = header.params.map((_param, index) => base + index);
    // The preheader terminator needs its own location id: reusing the header's
    // would overwrite its `stepsAfter` entry in the codegen plan. The new
    // location describes the header's terminator position and is marked as a
    // terminator; that is all the verifier requires for an inserted block.
    const template = fn.locs.locations[header.term.loc]!;
    const location: (typeof fn.locs.locations)[number] = Object.freeze({
      ...template,
      terminator: true as const,
    });
    const locationId = fn.locs.locations.length;
    const locations = [...fn.locs.locations, location];
    const stepsAfter = new Int32Array(locations.length).fill(-1);
    stepsAfter.set(fn.locs.stepsAfter.subarray(0, Math.min(fn.locs.stepsAfter.length, locationId)));
    const parent = new Int32Array(locations.length).fill(-1);
    parent.set(fn.locs.parent.subarray(0, Math.min(fn.locs.parent.length, locationId)));
    locs = { ...fn.locs, locations, stepsAfter, parent };

    inserted = {
      id,
      params,
      insts: [...moved],
      term: {
        kind: 'jump',
        target: loop.header,
        args: [...params],
        loc: locationId,
        step: 0,
      },
      preds: [],
      succs: [],
    };
    const appended: MValue[] = header.params.map((param, index) => {
      const original = fn.values[param]!;
      return { id: params[index]!, type: original.type, rep: original.rep, def: inserted! };
    });
    values = [...fn.values, ...appended];
    blocks.set(id, inserted);
    for (const predId of outside) {
      const target = blocks.get(predId)!;
      target.term = redirectTerm(target.term, loop.header, id);
    }
  }

  const ordered = fn.blocks.map((block) => blocks.get(block.id)!);
  if (inserted !== undefined) ordered.push(inserted);
  return rebuildFunction({ ...fn, values, locs }, ordered).fn;
}

/** Retarget every edge to `header` at `preheader`, keeping arguments/steps. */
function redirectTerm(term: MTerm, header: number, preheader: number): MTerm {
  if (term.kind === 'jump') {
    return term.target === header
      ? { ...term, target: preheader, args: [...term.args] }
      : copyTerm(term);
  }
  if (term.kind === 'branch') {
    return {
      ...term,
      yes:
        term.yes.target === header
          ? { target: preheader, args: [...term.yes.args] }
          : copyEdge(term.yes),
      no:
        term.no.target === header
          ? { target: preheader, args: [...term.no.args] }
          : copyEdge(term.no),
    };
  }
  return copyTerm(term);
}

export function optimizeFunction(fn: MFunction): MFunction {
  let current = fn;
  const processed = new Set<number>();
  for (;;) {
    const analysis = analyzeCFG(current);
    const next = candidates(analysis.loops, processed)[0];
    if (next === undefined) break;
    processed.add(next.header);
    const updated = hoistLoop(current, next, analysis.cfg);
    if (updated !== current) current = updated;
  }
  return current;
}
