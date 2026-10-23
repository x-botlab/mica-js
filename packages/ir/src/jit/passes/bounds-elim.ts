/**
 * Bounds-check elimination and loop versioning (J12, `boundsElim`).
 *
 * Two complementary rewrites use the integer range information from #151:
 *
 * 1. **Static elimination**: when `analyzeRanges` proves an array index in
 *    `[0, LEN)` (or a byte interval inside the record), the access loses its
 *    bounds slow path (`MInst.uncheckedBounds`).
 * 2. **Loop versioning (hoisting)**: for a natural loop with a basic induction
 *    variable `i` (`i + c` on every back edge, `i < n` / `i <= n` exit) and
 *    accesses of the form `array[i * s + k]` / `bytes[i * s + k]`, a pure
 *    `bounds.guard` is computed in the preheader. The guard's `branch` selects
 *    either a cloned loop whose proven accesses carry `uncheckedBounds`, or the
 *    original loop. The guard costs no steps and cannot throw.
 *
 * The slow copy is always the untouched original loop, so an access that really
 * is out of range throws from exactly the same instruction, with the same
 * location and step count as the unoptimized program.
 */
import { analyzeCFG, blockEdges } from '../cfg';
import type { Loop } from '../cfg';
import { Op } from '../mir';
import type { MBlock, MEdge, MFunction, MInst, MTerm, ValueId } from '../mir';
import { analyzeRanges } from './range';
import type { Interval } from './range';
import {
  NUMERIC_BYTES,
  byteLength,
  constantNumber,
  definingBlock,
  instructionOf,
  scalarLayout,
} from './memory-model';
import type { MemoryPassContext } from './memory-model';
import type { NumericType } from '../../types';

interface Induction {
  readonly header: MBlock;
  readonly preheader: MBlock;
  readonly jump: Extract<MTerm, { kind: 'jump' }>;
  readonly param: ValueId;
  readonly paramIndex: number;
  readonly equivalents: ReadonlySet<ValueId>;
  readonly init: ValueId;
  readonly bound: ValueId;
  readonly relation: 0 | 1;
  readonly stride: number;
}

interface Affine {
  readonly scale: number;
  readonly offset: number;
}

interface Candidate {
  readonly inst: MInst;
  readonly memory: number;
  readonly scale: number;
  readonly offset: number;
  readonly width: number;
}

/**
 * Block parameters that carry the same value as the loop header's induction
 * variable. In SSA, the body usually refers to its own parameter, not the
 * header parameter, so the induction must be followed through block edges.
 */
function inductionEquivalents(fn: MFunction, loop: Loop, headerParam: ValueId): Set<ValueId> {
  const equivalents = new Set<ValueId>([headerParam]);
  const blockById = new Map(fn.blocks.map((block) => [block.id, block]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const blockId of loop.blocks) {
      const block = blockById.get(blockId);
      if (block === undefined) continue;
      for (const predId of fn.blocks) {
        if (!loop.blocks.has(predId.id)) continue;
        for (const edge of blockEdges(predId.term)) {
          if (edge.target !== blockId) continue;
          edge.args.forEach((arg, index) => {
            const param = block.params[index];
            if (param === undefined || equivalents.has(param) || !equivalents.has(arg)) return;
            equivalents.add(param);
            changed = true;
          });
        }
      }
    }
  }
  return equivalents;
}

/** Recognise `i * scale + offset` (scale 1 when the expression is just `i`). */
function affineOf(
  fn: MFunction,
  value: ValueId,
  induction: ReadonlySet<ValueId>,
  depth = 0,
): Affine | undefined {
  if (induction.has(value)) return { scale: 1, offset: 0 };
  if (depth > 8) return undefined;
  const inst = instructionOf(fn, value);
  if (inst === undefined) return undefined;
  if (inst.op === Op.IntAdd) {
    const left = inst.args[0];
    const right = inst.args[1];
    if (left === undefined || right === undefined) return undefined;
    const leftConstant = constantNumber(fn, left);
    if (leftConstant !== undefined) {
      const rest = affineOf(fn, right, induction, depth + 1);
      return rest === undefined
        ? undefined
        : { scale: rest.scale, offset: rest.offset + leftConstant };
    }
    const rightConstant = constantNumber(fn, right);
    if (rightConstant !== undefined) {
      const rest = affineOf(fn, left, induction, depth + 1);
      return rest === undefined
        ? undefined
        : { scale: rest.scale, offset: rest.offset + rightConstant };
    }
    return undefined;
  }
  if (inst.op === Op.IntSub) {
    const left = inst.args[0];
    const right = inst.args[1];
    if (left === undefined || right === undefined) return undefined;
    const rightConstant = constantNumber(fn, right);
    if (rightConstant === undefined) return undefined;
    const rest = affineOf(fn, left, induction, depth + 1);
    return rest === undefined
      ? undefined
      : { scale: rest.scale, offset: rest.offset - rightConstant };
  }
  if (inst.op === Op.IntMul) {
    const left = inst.args[0];
    const right = inst.args[1];
    if (left === undefined || right === undefined) return undefined;
    const leftConstant = constantNumber(fn, left);
    const rightConstant = constantNumber(fn, right);
    if (leftConstant !== undefined) {
      const rest = affineOf(fn, right, induction, depth + 1);
      const scale = rest === undefined ? undefined : rest.scale * leftConstant;
      return rest === undefined || scale === undefined || !Number.isSafeInteger(scale)
        ? undefined
        : { scale, offset: rest.offset * leftConstant };
    }
    if (rightConstant !== undefined) {
      const rest = affineOf(fn, left, induction, depth + 1);
      const scale = rest === undefined ? undefined : rest.scale * rightConstant;
      return rest === undefined || scale === undefined || !Number.isSafeInteger(scale)
        ? undefined
        : { scale, offset: rest.offset * rightConstant };
    }
    return undefined;
  }
  return undefined;
}

/** Memory length used by the guard: elements for arrays, bytes for byte records. */
function accessWidth(context: MemoryPassContext, inst: MInst): number | undefined {
  if (inst.op === Op.BytesLoad || inst.op === Op.BytesStore) {
    return NUMERIC_BYTES[inst.imm[0] as NumericType] ?? 1;
  }
  if (inst.op === Op.ArrayLoad || inst.op === Op.ArrayStore) return 1;
  return undefined;
}

function accessMemory(context: MemoryPassContext, inst: MInst): number | undefined {
  const memory = inst.refs[0];
  if (memory === undefined) return undefined;
  if (inst.op === Op.ArrayLoad || inst.op === Op.ArrayStore) {
    return scalarLayout(context, memory, 'array') === undefined ? undefined : memory;
  }
  if (inst.op === Op.BytesLoad || inst.op === Op.BytesStore) {
    return byteLength(context, memory) === undefined ? undefined : memory;
  }
  return undefined;
}

function accessIndex(inst: MInst): ValueId | undefined {
  switch (inst.op) {
    case Op.ArrayLoad:
    case Op.ArrayStore:
    case Op.BytesLoad:
    case Op.BytesStore:
      return inst.args[0];
    default:
      return undefined;
  }
}

/** Static elimination using the #151 ranges. Returns the number marked. */
function eliminateStatically(
  fn: MFunction,
  context: MemoryPassContext,
  ranges: ReadonlyMap<ValueId, Interval>,
): number {
  let marked = 0;
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      if (inst.uncheckedBounds === true) continue;
      const memory = accessMemory(context, inst);
      const index = accessIndex(inst);
      const width = accessWidth(context, inst);
      if (memory === undefined || index === undefined || width === undefined) continue;
      const interval = ranges.get(index);
      if (interval === undefined || interval.lo < 0) continue;
      const length =
        inst.op === Op.ArrayLoad || inst.op === Op.ArrayStore
          ? scalarLayout(context, memory, 'array')!.length
          : byteLength(context, memory)!;
      if (interval.hi + width > length) continue;
      if (interval.hi > 0xffff_ffff) continue;
      inst.uncheckedBounds = true;
      marked += 1;
    }
  }
  return marked;
}

/** Find the unique preheader and the basic induction variable of one loop. */
function findInduction(fn: MFunction, loop: Loop): Induction | undefined {
  const header = fn.blocks.find((block) => block.id === loop.header);
  if (header === undefined || header.term.kind !== 'branch') return undefined;
  const comparison = instructionOf(fn, header.term.cond);
  if (comparison === undefined || comparison.op !== Op.IntCmp) return undefined;
  if (definingBlock(fn, header.term.cond)?.id !== header.id) return undefined;

  const outside = fn.blocks.filter(
    (block) =>
      !loop.blocks.has(block.id) &&
      blockEdges(block.term).some((edge) => edge.target === header.id),
  );
  if (outside.length !== 1) return undefined;
  const preheader = outside[0]!;
  if (preheader.term.kind !== 'jump' || preheader.term.target !== header.id) return undefined;

  const predicate = String(comparison.imm[0] ?? '');
  const [left, right] = comparison.args as [ValueId, ValueId];
  const relations: {
    readonly param: ValueId;
    readonly bound: ValueId;
    readonly relation: 0 | 1;
  }[] = [];
  if ((predicate === 'lt' || predicate === 'le') && header.params.includes(left)) {
    relations.push({ param: left, bound: right, relation: predicate === 'lt' ? 0 : 1 });
  }
  if ((predicate === 'gt' || predicate === 'ge') && header.params.includes(right)) {
    relations.push({ param: right, bound: left, relation: predicate === 'gt' ? 0 : 1 });
  }

  for (const relation of relations) {
    // The guard instruction is typed u32 (array/byte offsets are u32).
    if (fn.values[relation.param]?.type !== 'u32') continue;
    if (fn.values[relation.bound]?.type !== 'u32') continue;
    const boundBlock = definingBlock(fn, relation.bound);
    if (boundBlock !== undefined && loop.blocks.has(boundBlock.id)) continue;
    const paramIndex = header.params.indexOf(relation.param);
    const init = preheader.term.args[paramIndex];
    if (init === undefined) continue;
    const equivalents = inductionEquivalents(fn, loop, relation.param);
    let stride: number | undefined;
    let valid = true;
    for (const latch of loop.latches) {
      const latchBlock = fn.blocks.find((block) => block.id === latch);
      if (latchBlock === undefined) {
        valid = false;
        break;
      }
      const edge = blockEdges(latchBlock.term).find((candidate) => candidate.target === header.id);
      if (edge === undefined) {
        valid = false;
        break;
      }
      const updated = edge.args[paramIndex];
      if (updated === undefined) {
        valid = false;
        break;
      }
      const add = instructionOf(fn, updated);
      if (add === undefined || add.op !== Op.IntAdd || definingBlock(fn, updated)?.id !== latch) {
        valid = false;
        break;
      }
      const [first, second] = add.args as [ValueId, ValueId];
      let increment: number | undefined;
      if (equivalents.has(first)) increment = constantNumber(fn, second);
      else if (equivalents.has(second)) increment = constantNumber(fn, first);
      if (increment === undefined || increment <= 0) {
        valid = false;
        break;
      }
      if (stride === undefined) stride = increment;
      else if (stride !== increment) {
        valid = false;
        break;
      }
    }
    if (!valid || stride === undefined) continue;
    return {
      header,
      preheader,
      jump: preheader.term,
      param: relation.param,
      paramIndex,
      equivalents,
      init,
      bound: relation.bound,
      relation: relation.relation,
      stride,
    };
  }
  return undefined;
}

function collectCandidates(
  fn: MFunction,
  context: MemoryPassContext,
  loop: Loop,
  induction: Induction,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<MInst>();
  for (const blockId of loop.blocks) {
    const block = fn.blocks.find((candidate) => candidate.id === blockId);
    if (block === undefined) continue;
    for (const inst of block.insts) {
      if (inst.uncheckedBounds === true || seen.has(inst)) continue;
      const memory = accessMemory(context, inst);
      const index = accessIndex(inst);
      const width = accessWidth(context, inst);
      if (memory === undefined || index === undefined || width === undefined) continue;
      const affine = affineOf(fn, index, induction.equivalents);
      if (
        affine === undefined ||
        !Number.isSafeInteger(affine.scale) ||
        !Number.isSafeInteger(affine.offset)
      ) {
        continue;
      }
      seen.add(inst);
      candidates.push({ inst, memory, scale: affine.scale, offset: affine.offset, width });
    }
  }
  return candidates;
}

function cloneLoop(fn: MFunction, loop: Loop, candidates: ReadonlySet<MInst>): Map<number, number> {
  const ids = new Map<number, number>();
  let nextId = fn.blocks.reduce((max, block) => Math.max(max, block.id), -1) + 1;
  const sorted = [...loop.blocks].sort((left, right) => left - right);
  for (const id of sorted) {
    ids.set(id, nextId);
    nextId += 1;
  }

  const valueMap = new Map<ValueId, ValueId>();
  const blocks = new Map<number, MBlock>();
  // Phase 1: allocate block parameters and every instruction result so uses in
  // any block can be translated before the copies are built.
  for (const id of sorted) {
    const original = fn.blocks.find((block) => block.id === id)!;
    const block: MBlock = {
      id: ids.get(id)!,
      params: [],
      insts: [],
      term: original.term,
      preds: [],
      succs: [],
    };
    for (const param of original.params) {
      const value: ValueId = fn.values.length;
      fn.values.push({
        id: value,
        type: fn.values[param]!.type,
        rep: fn.values[param]!.rep,
        def: block,
      });
      block.params.push(value);
      valueMap.set(param, value);
    }
    blocks.set(id, block);
  }
  const resultMap = new Map<MInst, ValueId[]>();
  for (const id of sorted) {
    const original = fn.blocks.find((block) => block.id === id)!;
    for (const inst of original.insts) {
      const results = inst.results.map((result) => {
        const value: ValueId = fn.values.length;
        fn.values.push({
          id: value,
          type: fn.values[result]!.type,
          rep: fn.values[result]!.rep,
          def: inst,
        });
        valueMap.set(result, value);
        return value;
      });
      resultMap.set(inst, results);
    }
  }

  const mapValue = (value: ValueId): ValueId => valueMap.get(value) ?? value;
  const mapEdge = (edge: MEdge): MEdge => ({
    target: ids.get(edge.target) ?? edge.target,
    args: edge.args.map(mapValue),
  });
  const mapTerm = (term: MTerm): MTerm => {
    switch (term.kind) {
      case 'jump':
        return {
          kind: 'jump',
          target: ids.get(term.target) ?? term.target,
          args: term.args.map(mapValue),
          loc: term.loc,
          step: term.step,
        };
      case 'branch':
        return {
          kind: 'branch',
          cond: mapValue(term.cond),
          yes: mapEdge(term.yes),
          no: mapEdge(term.no),
          loc: term.loc,
          step: term.step,
        };
      case 'return':
        return {
          kind: 'return',
          values: term.values.map(mapValue),
          loc: term.loc,
          step: term.step,
        };
      case 'dispatch':
        return {
          kind: 'dispatch',
          provider: term.provider,
          key: term.key.map(mapValue),
          args: term.args.map(mapValue),
          loc: term.loc,
          step: term.step,
        };
      case 'trap':
        return { kind: 'trap', code: term.code, loc: term.loc, step: term.step };
    }
  };

  // Phase 2: clone instructions and terminators with the full translation.
  for (const id of sorted) {
    const original = fn.blocks.find((block) => block.id === id)!;
    const block = blocks.get(id)!;
    for (const inst of original.insts) {
      const results = resultMap.get(inst)!;
      const copy: MInst = {
        op: inst.op,
        args: inst.args.map(mapValue),
        results,
        imm: [...inst.imm],
        refs: [...inst.refs],
        node: inst.node,
        loc: inst.loc,
        step: inst.step,
      };
      if (inst.listSplit !== undefined) copy.listSplit = [...inst.listSplit];
      if (inst.constRep !== undefined) copy.constRep = inst.constRep;
      if (candidates.has(inst) || inst.uncheckedBounds === true) copy.uncheckedBounds = true;
      block.insts.push(copy);
      for (const result of results) fn.values[result]!.def = copy;
    }
    block.term = mapTerm(original.term);
    fn.blocks.push(block);
  }
  return ids;
}

/** Version one loop; returns the number of accesses that lost their check. */
function versionLoop(fn: MFunction, context: MemoryPassContext, loop: Loop): number {
  if (loop.children.length > 0) return 0;
  const induction = findInduction(fn, loop);
  if (induction === undefined) return 0;
  const candidates = collectCandidates(fn, context, loop, induction);
  if (candidates.length === 0) return 0;

  const guardValue: ValueId = fn.values.length;
  const guard: MInst = {
    op: Op.BoundsGuard,
    args: [induction.init, induction.bound],
    results: [guardValue],
    imm: [
      induction.relation,
      induction.stride,
      ...candidates.flatMap((candidate) => [candidate.scale, candidate.offset, candidate.width]),
    ],
    refs: candidates.map((candidate) => candidate.memory),
    node: undefined,
    loc: induction.jump.loc,
    step: 0,
  };
  fn.values.push({ id: guardValue, type: 'bool', rep: 'bool', def: guard });
  induction.preheader.insts.push(guard);

  const candidateSet = new Set(candidates.map((candidate) => candidate.inst));
  const ids = cloneLoop(fn, loop, candidateSet);

  induction.preheader.term = {
    kind: 'branch',
    cond: guardValue,
    yes: { target: ids.get(loop.header)!, args: [...induction.jump.args] },
    no: { target: loop.header, args: [...induction.jump.args] },
    loc: induction.jump.loc,
    // Preserve a synthetic (step 0) inline jump from an earlier pass.
    step: induction.jump.step,
  };
  return candidates.length;
}

export interface BoundsElimResult {
  /** Accesses whose bounds slow path was removed. */
  readonly eliminated: number;
  /** Loops that received a fast/slow copy pair. */
  readonly versioned: number;
}

/**
 * Run bounds elimination on one function. Static proofs mark accesses in
 * place; dynamic induction ranges add a loop-versioning guard.
 */
export function runBoundsElim(fn: MFunction, context: MemoryPassContext): BoundsElimResult {
  const ranges = analyzeRanges(fn).values;
  const eliminated = eliminateStatically(fn, context, ranges);
  const analysis = analyzeCFG(fn);
  let versioned = 0;
  let hoisted = 0;
  for (const loop of analysis.loops) {
    const count = versionLoop(fn, context, loop);
    if (count > 0) {
      versioned += 1;
      hoisted += count;
    }
  }
  return { eliminated: eliminated + hoisted, versioned };
}
