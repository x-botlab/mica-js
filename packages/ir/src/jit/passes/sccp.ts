/**
 * Sparse conditional constant propagation (SCCP).
 *
 * The value lattice is `⊤` (no information yet), a concrete constant, or `⊥`
 * (overdefined). Executable blocks are discovered from the entry while the
 * lattice is solved to a fixed point, so values that are only constant on the
 * executed path are still folded.
 *
 * Folding reuses the reference evaluators (`evaluateScalarInstruction` /
 * `evaluateFloatInstruction`), exactly like the heap tier, so no second
 * semantics table exists. Evaluations that throw are treated as overdefined
 * and keep the original instruction, which preserves the original error
 * location and message.
 */
import { EFFECT_INFO } from '../effects';
import { evaluateFloatInstruction } from '../../float';
import { isFloatType } from '../../runtime';
import { evaluateScalarInstruction } from '../../scalar';
import type { FloatBits, RuntimeScalar, ScalarType } from '../../types';
import { Op } from '../mir';
import type { MBlock, MFunction, MInst, MTerm, ValueId } from '../mir';
import {
  isFloatBits,
  isPure,
  rebuildFunction,
  sameConstant,
  terminatorEdges,
  type OptimizeOptions,
  type ScalarConstant,
} from './util';

type Lattice =
  | { readonly kind: 'top' }
  | { readonly kind: 'const'; readonly value: ScalarConstant }
  | { readonly kind: 'bottom' };

const TOP: Lattice = Object.freeze({ kind: 'top' });
const BOTTOM: Lattice = Object.freeze({ kind: 'bottom' });

function constant(value: ScalarConstant): Lattice {
  return Object.freeze({ kind: 'const' as const, value });
}

function meet(left: Lattice, right: Lattice): Lattice {
  if (left.kind === 'top') return right;
  if (right.kind === 'top') return left;
  if (left.kind === 'bottom' || right.kind === 'bottom') return BOTTOM;
  return sameConstant(left.value, right.value) ? left : BOTTOM;
}

function edgeKey(block: number, edge: number): string {
  return `${block}:${edge}`;
}

/** Intern an exact float bit pattern into the module constant table. */
function internFloat(constants: unknown[] | undefined, value: FloatBits): number | undefined {
  if (constants === undefined) return undefined;
  for (let index = 0; index < constants.length; index += 1) {
    const existing = constants[index];
    if (isFloatBits(existing) && existing.type === value.type && existing.bits === value.bits) {
      return index;
    }
  }
  constants.push(value);
  return constants.length - 1;
}

function typeOfResult(fn: MFunction, inst: MInst): ScalarType | undefined {
  const id = inst.results[0];
  return id === undefined ? undefined : fn.values[id]?.type;
}

function constOfInst(
  fn: MFunction,
  inst: MInst,
  constants: readonly unknown[] | undefined,
): Lattice {
  const type = typeOfResult(fn, inst);
  if (type === undefined || inst.imm.length !== 1) return BOTTOM;
  if (isFloatType(type)) {
    if (inst.constRep === 'U') {
      const index = inst.imm[0];
      if (typeof index !== 'number' || constants === undefined) return BOTTOM;
      const value = constants[index];
      return isFloatBits(value) ? constant(value) : BOTTOM;
    }
    return typeof inst.imm[0] === 'number' ? constant(inst.imm[0]) : BOTTOM;
  }
  if (type === 'bool') {
    return typeof inst.imm[0] === 'boolean' ? constant(inst.imm[0]) : BOTTOM;
  }
  return typeof inst.imm[0] === 'number' ? constant(inst.imm[0]) : BOTTOM;
}

function foldable(inst: MInst): boolean {
  if (inst.op === Op.Const || inst.op === Op.Check || inst.op === Op.Spill) return false;
  if (inst.op === Op.Call || inst.op === Op.Executor) return false;
  const info = EFFECT_INFO[inst.op];
  return info !== undefined && isPure(info);
}

/**
 * Evaluate one instruction under the current lattice. `⊤` operands keep the
 * result at `⊤` (information may still arrive), `⊥` operands make it `⊥`.
 */
function evalInst(
  fn: MFunction,
  inst: MInst,
  constants: readonly unknown[] | undefined,
  resolve: (id: ValueId) => Lattice,
): Lattice {
  if (inst.op === Op.Const) return constOfInst(fn, inst, constants);
  if (inst.results.length !== 1) return BOTTOM;
  const resultType = typeOfResult(fn, inst);
  if (resultType === undefined) return BOTTOM;

  if (inst.op === Op.Select) {
    const condition = resolve(inst.args[0]!);
    if (condition.kind === 'const' && typeof condition.value === 'boolean') {
      const chosen = inst.args[condition.value ? 1 : 2];
      return chosen === undefined ? BOTTOM : resolve(chosen);
    }
    if (condition.kind === 'bottom') return BOTTOM;
    if (condition.kind === 'top') return TOP;
    const left = resolve(inst.args[1]!);
    const right = resolve(inst.args[2]!);
    if (left.kind === 'const' && right.kind === 'const' && sameConstant(left.value, right.value)) {
      return left;
    }
    if (left.kind === 'bottom' || right.kind === 'bottom') return BOTTOM;
    return TOP;
  }

  if (inst.node === undefined) return BOTTOM;

  let top = false;
  const operands: ScalarConstant[] = [];
  for (const id of inst.args) {
    const value = resolve(id);
    if (value.kind === 'bottom') return BOTTOM;
    if (value.kind === 'top') {
      top = true;
      continue;
    }
    operands.push(value.value);
  }
  if (top) return TOP;
  if (!foldable(inst)) return BOTTOM;

  try {
    const floatEvaluation =
      isFloatType(resultType) || inst.args.some((id) => isFloatType(fn.values[id]!.type));
    if (floatEvaluation) {
      const result = evaluateFloatInstruction(inst.node, operands as readonly RuntimeScalar[]);
      if (resultType === 'bool') {
        if (typeof result !== 'boolean') return BOTTOM;
        return constant(result);
      }
      if (isFloatType(resultType)) {
        if (typeof result === 'boolean') return BOTTOM;
        if (isFloatBits(result)) {
          // A `D` value must stay a JS number; only an already-`U` value may be
          // replaced by an exact FloatBits constant.
          if (fn.values[inst.results[0]!]!.rep === 'D') return BOTTOM;
          if (constants === undefined) return BOTTOM;
        }
        return constant(result as ScalarConstant);
      }
      if (typeof result !== 'number') return BOTTOM;
      return constant(result);
    }
    const result = evaluateScalarInstruction(inst.node, operands as readonly (boolean | number)[]);
    return constant(result as ScalarConstant);
  } catch {
    // A fold that throws stays overdefined: the original instruction is kept so
    // the runtime reports the original error with the original location.
    return BOTTOM;
  }
}

/** Fold one instruction into an `Op.Const` with the same result id. */
function foldedConst(
  fn: MFunction,
  inst: MInst,
  value: ScalarConstant,
  constants: unknown[] | undefined,
): MInst | undefined {
  const type = typeOfResult(fn, inst);
  if (type === undefined) return undefined;
  if (isFloatBits(value)) {
    const index = internFloat(constants, value);
    if (index === undefined) return undefined;
    return {
      op: Op.Const,
      args: [],
      results: [...inst.results],
      imm: [index],
      refs: [],
      node: inst.node,
      loc: inst.loc,
      step: inst.step,
      constRep: 'U',
    };
  }
  const replacement: MInst = {
    op: Op.Const,
    args: [],
    results: [...inst.results],
    imm: [value],
    refs: [],
    node: inst.node,
    loc: inst.loc,
    step: inst.step,
  };
  if (isFloatType(type)) replacement.constRep = 'D';
  return replacement;
}

/** Rewrite a constant branch as the equivalent jump (same `loc` and step). */
function foldBranch(term: Extract<MTerm, { kind: 'branch' }>, condition: boolean): MTerm {
  const edge = condition ? term.yes : term.no;
  return {
    kind: 'jump',
    target: edge.target,
    args: [...edge.args],
    loc: term.loc,
    step: term.step,
  };
}

/**
 * Sparse conditional constant propagation, unreachable-block removal and
 * branch folding.
 */
export function optimizeFunction(fn: MFunction, options: OptimizeOptions = {}): MFunction {
  const constants = options.constants;
  // Work on fresh block shells: instruction and terminator objects are only
  // replaced (never mutated), so the input function stays untouched.
  const work: MBlock[] = fn.blocks.map((block) => ({
    id: block.id,
    params: [...block.params],
    insts: [...block.insts],
    term: block.term,
    preds: [],
    succs: [],
  }));
  const lattice = new Map<ValueId, Lattice>();
  const resolve = (id: ValueId): Lattice => lattice.get(id) ?? TOP;
  const executable = new Set<number>([0]);
  const executableEdges = new Set<string>();

  // Function arguments have no compile-time value; entry block parameters are
  // overdefined from the start so a branch on them keeps both successors.
  const entry = work.find((block) => block.id === 0);
  if (entry !== undefined) {
    for (const param of entry.params) lattice.set(param, BOTTOM);
  }

  const update = (id: ValueId, value: Lattice): boolean => {
    const previous = resolve(id);
    const next = meet(previous, value);
    if (next === previous) return false;
    if (next.kind === 'const' && previous.kind === 'const') return false;
    lattice.set(id, next);
    return true;
  };

  const markEdge = (block: number, edge: number): boolean => {
    const key = edgeKey(block, edge);
    if (executableEdges.has(key)) return false;
    executableEdges.add(key);
    return true;
  };

  for (let iteration = 0; ; iteration += 1) {
    if (iteration > 10_000) {
      throw new Error('SCCP failed: the lattice did not converge');
    }
    let changed = false;
    for (const block of work) {
      if (!executable.has(block.id)) {
        for (const pred of work) {
          const edges = terminatorEdges(pred.term);
          for (let index = 0; index < edges.length; index += 1) {
            if (edges[index]!.target === block.id && executableEdges.has(edgeKey(pred.id, index))) {
              executable.add(block.id);
              changed = true;
            }
          }
        }
        if (!executable.has(block.id)) continue;
      }
      // Block parameters are the meet of every executable incoming edge.
      block.params.forEach((param, index) => {
        let value: Lattice = TOP;
        for (const pred of work) {
          const edges = terminatorEdges(pred.term);
          for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
            const edge = edges[edgeIndex]!;
            if (edge.target !== block.id || !executableEdges.has(edgeKey(pred.id, edgeIndex))) {
              continue;
            }
            const arg = edge.args[index];
            if (arg === undefined) continue;
            value = meet(value, resolve(arg));
          }
        }
        if (value.kind === 'top') value = BOTTOM;
        if (update(param, value)) changed = true;
      });
      for (const inst of block.insts) {
        if (inst.results.length !== 1) {
          for (const result of inst.results) {
            if (update(result, BOTTOM)) changed = true;
          }
          continue;
        }
        if (update(inst.results[0]!, evalInst(fn, inst, constants, resolve))) changed = true;
      }
      const term = block.term;
      if (term.kind === 'jump') {
        if (markEdge(block.id, 0)) changed = true;
      } else if (term.kind === 'branch') {
        const condition = resolve(term.cond);
        if (condition.kind === 'const' && typeof condition.value === 'boolean') {
          if (markEdge(block.id, condition.value ? 0 : 1)) changed = true;
        } else {
          if (markEdge(block.id, 0)) changed = true;
          if (markEdge(block.id, 1)) changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // 1. Materialize constant results as `const` at their original position.
  let changed = false;
  for (const block of work) {
    if (!executable.has(block.id)) continue;
    for (let index = 0; index < block.insts.length; index += 1) {
      const inst = block.insts[index]!;
      if (inst.op === Op.Const || inst.results.length !== 1) continue;
      const value = resolve(inst.results[0]!);
      if (value.kind !== 'const') continue;
      const replacement = foldedConst(fn, inst, value.value, constants as unknown[] | undefined);
      if (replacement === undefined) continue;
      block.insts[index] = replacement;
      changed = true;
    }
  }
  // 2. Fold constant conditions; both branches still account for one step.
  for (const block of work) {
    if (!executable.has(block.id)) continue;
    const term = block.term;
    if (term.kind !== 'branch') continue;
    const value = resolve(term.cond);
    if (value.kind !== 'const' || typeof value.value !== 'boolean') continue;
    block.term = foldBranch(term, value.value);
    changed = true;
  }

  // 3. Drop every block that the final CFG cannot reach.
  const kept = new Set<number>();
  const stack = [0];
  const byId = new Map(work.map((block) => [block.id, block]));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (kept.has(id)) continue;
    const block = byId.get(id);
    if (block === undefined) continue;
    kept.add(id);
    for (const edge of terminatorEdges(block.term)) stack.push(edge.target);
  }
  const blocks: MBlock[] = work.filter((block) => kept.has(block.id));
  if (!changed && blocks.length === fn.blocks.length) return fn;

  // `rebuildFunction` copies every instruction and compacts the value table, so
  // the input function (and its blocks) stays untouched.
  return rebuildFunction(fn, blocks).fn;
}
