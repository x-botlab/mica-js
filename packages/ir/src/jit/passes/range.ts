/**
 * Integer range analysis and its three MIR rewrites (J11).
 *
 * Every integer value gets an inclusive interval `[lo, hi]` in the abstract
 * domain. Block parameters are refined on control-flow edges using the
 * `int.cmp` that guards the branch, loop headers use widening, and the result
 * is a sound over-approximation of every execution.
 *
 * The pass only performs rewrites whose proof is local:
 *
 * 1. `int.div` / `int.rem` lose their division-by-zero check when the divisor
 *    interval excludes zero (or the branch edge proves `d != 0`);
 * 2. shift counts lose the `count >= width` branch when the count is in
 *    `[0, width-1]`;
 * 3. `int.add` / `int.sub` / `int.mul` lose their wrap when the unwrapped
 *    result is provably inside both the type range and int32, but keep `| 0`
 *    to preserve the int32 type feedback.
 *
 * Hints are encoded as extra `imm` markers. Codegen and verification ignore
 * unknown markers, so a pass can be disabled without changing the program.
 */
import { isIntegerType } from '../../runtime';
import { Op } from '../mir';
import type { MBlock, MFunction, MInst, ValueId } from '../mir';
import type { ScalarType } from '../../types';
import { analyzeCFG } from '../cfg';
import { copyInst, rebuildFunction } from './util';

/** Inclusive integer interval; `lo > hi` denotes the empty set. */
export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

const EMPTY: Interval = Object.freeze({ lo: 1, hi: 0 });

const WIDTH: Readonly<Record<string, number>> = {
  u8: 8,
  i8: 8,
  u16: 16,
  i16: 16,
  u32: 32,
  i32: 32,
};

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

function typeRange(type: ScalarType): Interval {
  switch (type) {
    case 'u8':
      return { lo: 0, hi: 255 };
    case 'i8':
      return { lo: -128, hi: 127 };
    case 'u16':
      return { lo: 0, hi: 65_535 };
    case 'i16':
      return { lo: -32_768, hi: 32_767 };
    case 'u32':
      return { lo: 0, hi: 4_294_967_295 };
    case 'i32':
    default:
      return { lo: INT32_MIN, hi: INT32_MAX };
  }
}

function isEmpty(value: Interval): boolean {
  return value.lo > value.hi;
}

function join(left: Interval, right: Interval): Interval {
  if (isEmpty(left)) return right;
  if (isEmpty(right)) return left;
  return { lo: Math.min(left.lo, right.lo), hi: Math.max(left.hi, right.hi) };
}

function meet(left: Interval, right: Interval): Interval {
  const result = { lo: Math.max(left.lo, right.lo), hi: Math.min(left.hi, right.hi) };
  return isEmpty(result) ? EMPTY : result;
}

function clamp(type: ScalarType, value: Interval): Interval {
  return meet(value, typeRange(type));
}

function excludesZero(value: Interval): boolean {
  return !isEmpty(value) && (value.lo > 0 || value.hi < 0);
}

function safeArithmetic(values: readonly number[]): boolean {
  return values.every((value) => Number.isSafeInteger(value));
}

function unwrapped(
  type: ScalarType,
  op: Op,
  left: Interval,
  right: Interval,
): Interval | undefined {
  if (isEmpty(left) || isEmpty(right)) return EMPTY;
  if (op === Op.IntAdd) {
    const values = [left.lo + right.lo, left.lo + right.hi, left.hi + right.lo, left.hi + right.hi];
    if (!safeArithmetic(values)) return undefined;
    return { lo: Math.min(...values), hi: Math.max(...values) };
  }
  if (op === Op.IntSub) {
    const values = [left.lo - right.lo, left.lo - right.hi, left.hi - right.lo, left.hi - right.hi];
    if (!safeArithmetic(values)) return undefined;
    return { lo: Math.min(...values), hi: Math.max(...values) };
  }
  if (op === Op.IntMul) {
    const values = [left.lo * right.lo, left.lo * right.hi, left.hi * right.lo, left.hi * right.hi];
    if (!safeArithmetic(values)) return undefined;
    return { lo: Math.min(...values), hi: Math.max(...values) };
  }
  return undefined;
}

/** Transfer function for integer instructions. */
function transfer(inst: MInst, type: ScalarType, args: readonly Interval[]): Interval {
  const range = typeRange(type);
  switch (inst.op) {
    case Op.Const: {
      const value = inst.imm[0];
      return typeof value === 'number' ? { lo: value, hi: value } : range;
    }
    case Op.IntAdd:
    case Op.IntSub:
    case Op.IntMul: {
      const raw = unwrapped(type, inst.op, args[0] ?? range, args[1] ?? range);
      return raw === undefined ? range : clamp(type, raw);
    }
    case Op.IntAnd: {
      const left = args[0] ?? range;
      const right = args[1] ?? range;
      if (left.lo >= 0 && right.lo >= 0) {
        return { lo: 0, hi: Math.min(left.hi, right.hi, range.hi) };
      }
      return range;
    }
    case Op.IntZext:
    case Op.IntSext:
    case Op.IntTrunc:
    case Op.IntReinterpret:
    case Op.IntOr:
    case Op.IntXor:
    case Op.IntNot:
    case Op.IntShl:
    case Op.IntLshr:
    case Op.IntAshr:
    case Op.IntDiv:
    case Op.IntRem:
    case Op.ConvertFloatToInt:
      return range;
    case Op.Select: {
      const condition = args[0];
      if (condition !== undefined && condition.lo === condition.hi) {
        return condition.lo === 0 ? (args[2] ?? range) : (args[1] ?? range);
      }
      return join(args[1] ?? range, args[2] ?? range);
    }
    default:
      return range;
  }
}

function typeOfValue(fn: MFunction, id: ValueId): ScalarType {
  return fn.values[id]!.type;
}

function integerType(fn: MFunction, id: ValueId): ScalarType | undefined {
  const type = typeOfValue(fn, id);
  return isIntegerType(type) ? type : undefined;
}

function constantOf(
  fn: MFunction,
  defs: ReadonlyMap<ValueId, MInst>,
  id: ValueId,
): number | undefined {
  const def = defs.get(id);
  if (def === undefined || def.op !== Op.Const) return undefined;
  return typeof def.imm[0] === 'number' ? def.imm[0] : undefined;
}

interface Refinement {
  readonly interval?: Interval;
  readonly nonzero?: boolean;
}

/** Refine `value` on one branch edge using `int.cmp`. */
function refine(
  fn: MFunction,
  defs: ReadonlyMap<ValueId, MInst>,
  inst: MInst,
  value: ValueId,
  other: Interval,
  taken: boolean,
): Refinement {
  const predicate = String(inst.imm[0] ?? '');
  const left = inst.args[0];
  const right = inst.args[1];
  if (left === undefined || right === undefined) return {};
  const isLeft = value === left;
  const isRight = value === right;
  if (!isLeft && !isRight) return {};

  // Translate "value is the right operand" into the mirrored predicate.
  const mirrored: Record<string, string> = {
    lt: 'gt',
    le: 'ge',
    gt: 'lt',
    ge: 'le',
    eq: 'eq',
    ne: 'ne',
  };
  const effective = isLeft ? predicate : (mirrored[predicate] ?? predicate);
  const truth = isLeft ? taken : taken;

  switch (effective) {
    case 'lt':
      return truth
        ? { interval: { lo: -Infinity, hi: other.hi - 1 } }
        : { interval: { lo: other.lo, hi: Infinity } };
    case 'le':
      return truth
        ? { interval: { lo: -Infinity, hi: other.hi } }
        : { interval: { lo: other.lo + 1, hi: Infinity } };
    case 'gt':
      return truth
        ? { interval: { lo: other.lo + 1, hi: Infinity } }
        : { interval: { lo: -Infinity, hi: other.hi } };
    case 'ge':
      return truth
        ? { interval: { lo: other.lo, hi: Infinity } }
        : { interval: { lo: -Infinity, hi: other.hi - 1 } };
    case 'eq': {
      if (truth) {
        if (other.lo === other.hi) return { interval: { lo: other.lo, hi: other.lo } };
        return {};
      }
      // `x == c` is false: `x != c`, which only proves non-zero for `c == 0`.
      if (other.lo === 0 && other.hi === 0) return { nonzero: true };
      return {};
    }
    case 'ne': {
      // `x != c` is true: `x` is non-zero only when the constant is zero.
      if (truth) {
        if (other.lo === 0 && other.hi === 0) return { nonzero: true };
        return {};
      }
      if (other.lo === 0 && other.hi === 0) {
        return { interval: { lo: 0, hi: 0 } };
      }
      return {};
    }
    default:
      return {};
  }
}

interface RangeResult {
  /** Interval of every integer value, valid on every execution path. */
  readonly values: ReadonlyMap<ValueId, Interval>;
  /** Block-entry interval of every block parameter. */
  readonly params: ReadonlyMap<ValueId, Interval>;
  /** Parameters proven to differ from zero on every incoming edge. */
  readonly nonzero: ReadonlySet<ValueId>;
}

/**
 * Run the interval analysis. Exposed for the unit tests; the pass itself only
 * consumes the final state.
 */
export function analyzeRanges(fn: MFunction): RangeResult {
  const cfg = analyzeCFG(fn);
  const graph = cfg.cfg;
  const defs = new Map<ValueId, MInst>();
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      for (const result of inst.results) defs.set(result, inst);
    }
  }

  const loopBlocks = new Set<number>();
  for (const loop of cfg.loops) for (const id of loop.blocks) loopBlocks.add(id);
  const reachable = new Set<number>(graph.order);

  const values = new Map<ValueId, Interval>();
  const params = new Map<ValueId, Interval>();
  const nonzero = new Set<ValueId>();

  const valueOf = (block: MBlock, id: ValueId): Interval | undefined => {
    const type = integerType(fn, id);
    if (type === undefined) return undefined;
    return params.get(id) ?? values.get(id) ?? typeRange(type);
  };
  const edgeRefinement = (pred: MBlock, arg: ValueId, taken: boolean): Refinement => {
    if (pred.term.kind !== 'branch') return {};
    const condition = pred.term.cond;
    const comparison = defs.get(condition);
    if (comparison === undefined || comparison.op !== Op.IntCmp) return {};
    if (comparison.args[0] === arg) {
      const other = comparison.args[1];
      if (other === undefined) return {};
      const interval = valueOf(pred, other);
      if (interval === undefined) return {};
      return refine(fn, defs, comparison, arg, interval, taken);
    }
    if (comparison.args[1] === arg) {
      const other = comparison.args[0];
      if (other === undefined) return {};
      const interval = valueOf(pred, other);
      if (interval === undefined) return {};
      return refine(fn, defs, comparison, arg, interval, taken);
    }
    return {};
  };

  const WIDEN_AFTER = 4;
  const MAX_ROUNDS = 24;
  let converged = false;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changed = false;
    for (const id of graph.order) {
      const block = fn.blocks.find((candidate) => candidate.id === id);
      if (block === undefined) continue;
      block.params.forEach((param, index) => {
        const type = integerType(fn, param);
        if (type === undefined) return;
        let interval = EMPTY;
        let provenNonzero = true;
        let edges = 0;
        for (const predId of graph.preds.get(block.id) ?? []) {
          // An unreachable predecessor contributes no execution path; its
          // empty intervals must not refine a reachable parameter.
          if (!reachable.has(predId)) continue;
          const pred = fn.blocks.find((candidate) => candidate.id === predId);
          if (pred === undefined) continue;
          for (const edge of edgeList(pred)) {
            if (edge.edge.target !== block.id) continue;
            const arg = edge.edge.args[index];
            if (arg === undefined) continue;
            edges += 1;
            const base = valueOf(pred, arg) ?? typeRange(type);
            const hint = edgeRefinement(pred, arg, edge.taken);
            let candidate = hint.interval === undefined ? base : meet(base, hint.interval);
            candidate = clamp(type, candidate);
            interval = join(interval, candidate);
            const argConstant = constantOf(fn, defs, arg);
            const argNonzero =
              hint.nonzero === true ||
              excludesZero(base) ||
              nonzero.has(arg) ||
              (argConstant !== undefined && argConstant !== 0);
            if (!argNonzero) provenNonzero = false;
          }
        }
        if (edges === 0) return;
        let next = interval;
        if (round >= WIDEN_AFTER && loopBlocks.has(block.id)) next = typeRange(type);
        if (isEmpty(params.get(param) ?? EMPTY)) {
          params.set(param, next);
          changed = true;
        } else if (!sameInterval(params.get(param)!, next)) {
          params.set(param, join(params.get(param)!, next));
          changed = true;
        }
        if (provenNonzero) {
          if (!nonzero.has(param)) {
            nonzero.add(param);
            changed = true;
          }
        } else if (nonzero.delete(param)) {
          changed = true;
        }
        const previous = values.get(param);
        const joined = previous === undefined ? next : join(previous, next);
        if (previous === undefined || !sameInterval(previous, joined)) {
          values.set(param, joined);
          changed = true;
        }
      });
      for (const inst of block.insts) {
        const result = inst.results[0];
        if (result === undefined) continue;
        const type = integerType(fn, result);
        if (type === undefined) continue;
        const args = inst.args.map((arg) => valueOf(block, arg) ?? typeRange(type));
        let next = transfer(inst, type, args);
        if (round >= WIDEN_AFTER && loopBlocks.has(block.id)) next = typeRange(type);
        const previous = values.get(result);
        const joined = previous === undefined ? next : join(previous, next);
        if (previous === undefined || !sameInterval(previous, joined)) {
          values.set(result, joined);
          changed = true;
        }
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    // A non-converged analysis proves nothing; fall back to full type ranges.
    values.clear();
    params.clear();
    nonzero.clear();
  }
  return { values, params, nonzero };
}

function edgeList(
  block: MBlock,
): { edge: { target: number; args: readonly ValueId[] }; taken: boolean }[] {
  const term = block.term;
  if (term.kind === 'jump')
    return [{ edge: { target: term.target, args: term.args }, taken: true }];
  if (term.kind === 'branch') {
    return [
      { edge: term.yes, taken: true },
      { edge: term.no, taken: false },
    ];
  }
  return [];
}

function sameInterval(left: Interval, right: Interval): boolean {
  return left.lo === right.lo && left.hi === right.hi;
}

function hasMarker(inst: MInst, marker: string): boolean {
  return inst.imm.some((value) => value === marker);
}

function addMarker(inst: MInst, marker: string): MInst | undefined {
  if (hasMarker(inst, marker)) return undefined;
  return copyInst(inst, { imm: [...inst.imm, marker] });
}

export function optimizeFunction(fn: MFunction): MFunction {
  const analysis = analyzeRanges(fn);
  const blocks = new Map<number, MBlock>();
  const defs = new Map<ValueId, MInst>();
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      for (const result of inst.results) defs.set(result, inst);
    }
  }
  for (const block of fn.blocks) {
    blocks.set(block.id, {
      id: block.id,
      params: [...block.params],
      insts: [...block.insts],
      term: block.term,
      preds: [],
      succs: [],
    });
  }

  const intervalOf = (block: MBlock, id: ValueId): Interval | undefined => {
    const type = integerType(fn, id);
    if (type === undefined) return undefined;
    return analysis.params.get(id) ?? analysis.values.get(id) ?? typeRange(type);
  };

  let changed = false;
  for (const block of blocks.values()) {
    block.insts.forEach((inst, index) => {
      const type = inst.results[0] === undefined ? undefined : integerType(fn, inst.results[0]!);
      if (type === undefined) return;
      const divisor = inst.args[1];
      if ((inst.op === Op.IntDiv || inst.op === Op.IntRem) && divisor !== undefined) {
        const interval = intervalOf(block, divisor);
        const proven =
          analysis.nonzero.has(divisor) || (interval !== undefined && excludesZero(interval));
        if (proven) {
          const marked = addMarker(inst, 'nozero');
          if (marked !== undefined) {
            block.insts[index] = marked;
            changed = true;
          }
        }
        return;
      }
      if (inst.op === Op.IntShl || inst.op === Op.IntLshr || inst.op === Op.IntAshr) {
        const count = inst.args[1];
        const interval = count === undefined ? undefined : intervalOf(block, count);
        const width = WIDTH[type as string] ?? 32;
        if (interval !== undefined && interval.lo >= 0 && interval.hi <= width - 1) {
          const marked = addMarker(inst, 'inrange');
          if (marked !== undefined) {
            block.insts[index] = marked;
            changed = true;
          }
        }
        return;
      }
      if (inst.op === Op.IntAdd || inst.op === Op.IntSub || inst.op === Op.IntMul) {
        // The spec excludes i32 and i32u from wrap omission; only narrow
        // integer types use `| 0` as the identity wrap.
        if (type === 'i32' || type === 'u32') return;
        const left = inst.args[0] === undefined ? undefined : intervalOf(block, inst.args[0]!);
        const right = inst.args[1] === undefined ? undefined : intervalOf(block, inst.args[1]!);
        if (left === undefined || right === undefined) return;
        const raw = unwrapped(type, inst.op, left, right);
        if (raw === undefined || isEmpty(raw)) return;
        const range = typeRange(type);
        if (raw.lo < range.lo || raw.hi > range.hi) return;
        if (raw.lo < INT32_MIN || raw.hi > INT32_MAX) return;
        const marked = addMarker(inst, 'nowrap');
        if (marked !== undefined) {
          block.insts[index] = marked;
          changed = true;
        }
      }
    });
  }

  if (!changed) return fn;
  return rebuildFunction(
    fn,
    fn.blocks.map((block) => blocks.get(block.id)!),
  ).fn;
}
