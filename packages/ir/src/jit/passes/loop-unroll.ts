/**
 * Small-loop unrolling (O02).
 *
 * A canonical counted loop is recognised from the CFG (`naturalLoops`) plus the
 * interval analysis of `./range`:
 *
 * ```
 * preheader            preheader
 *   jump header          jump U0
 * header(i):           U0: <header(i = 0)> <body>     ┐
 *   cmp i, limit         jump U1                       │ fully unrolled
 *   branch -> body/exit  U1: <header(i = 1)> <body>     │ (0-4 trips)
 * body:                  ...                          │
 *   jump header(i + 1)   UN: <header(i = N)>           ┘
 * exit:                  jump exit
 *                      exit
 * ```
 *
 * **Steps are preserved exactly.** The reference interpreter counts one step per
 * instruction and per terminator, and the JIT reproduces that count (the step
 * observer and the budget protocol read it). Unrolling therefore never deletes
 * a step: the branch of a header visit becomes a synthetic `Check` with
 * `step = 1` at the header terminator's location, and cloned instructions keep
 * their own `step` and location. A path through the unrolled code executes
 * exactly the same steps, at the same locations, in the same order.
 *
 * **Partial unrolling** (`N = 8 -> 2 x 4`, `N = 16 -> 4 x 4`) keeps the loop and
 * replicates the latch body `factor` times. The header visits that disappear
 * become `Check` step placeholders in front of each replicated body, so the step
 * sequence stays identical; what disappears is the compare and the back-edge
 * branch of `factor - 1` out of every `factor` iterations.
 *
 * Conservative restrictions (a loop is left alone when any applies):
 *
 * - the loop is not canonical: header + single latch, one exit from the header,
 *   a unique preheader edge, and a back edge that only targets the header;
 * - the trip count is not a compile-time constant (see {@link tripCount});
 * - the loop is irreducible, or the body contains host code, control transfer,
 *   or an operation that raises a value error (`div`, `rem`, float→int,
 *   bounds-checked access);
 * - one iteration is larger than {@link MAX_ITERATION_INSTRUCTIONS};
 * - the copies would exceed the function's growth allowance, which is computed
 *   once per function and consumed by every unrolled loop.
 */
import type { IRExecutionLocation } from '../../interpreter';
import { isIntegerType } from '../../runtime';
import type { ScalarType } from '../../types';
import { analyzeCFG } from '../cfg';
import type { CFGAnalysis, Loop } from '../cfg';
import { EFFECT_INFO } from '../effects';
import { Op } from '../mir';
import type {
  LocId,
  MBlock,
  MEdge,
  MFunction,
  MInlineFrame,
  MInst,
  MValue,
  MTerm,
  Rep,
  ValueId,
} from '../mir';
import { analyzeRanges } from './range';
import {
  blockMap,
  copyEdge,
  copyInst,
  copyTerm,
  freshBlockId,
  rebuildFunction,
  terminatorEdges,
} from './util';
import type { OptimizeOptions } from './util';

/** Trip counts up to this bound are unrolled completely. */
const MAX_FULL_ITERATIONS = 4;
/** Partial-unroll factors, largest first. */
const PARTIAL_FACTORS: readonly number[] = Object.freeze([4, 2]);
/** One iteration larger than this is never unrolled. */
const MAX_ITERATION_INSTRUCTIONS = 50;
/** Growth allowance as a fraction of the function's instruction count. */
const GROWTH_RATIO = 0.2;
/**
 * Floor for the growth allowance: a few hundred bytes of emitted code are
 * negligible, and without it a short loop in a short function (the case this
 * pass targets) could never be unrolled. Two short loops fit; a function with
 * many loops only unrolls as many as the ratio allows.
 */
const MIN_GROWTH = 128;
/** Loops with more trips are not worth unrolling: the copies stay small. */
const MAX_TRIP_COUNT = 64;

/** Options for {@link optimizeFunction}; every field has a tuned default. */
export interface UnrollOptions extends OptimizeOptions {
  /** Trip counts up to this bound are unrolled completely. Default 4. */
  readonly maxFullIterations?: number;
  /** One iteration larger than this is never unrolled. Default 50. */
  readonly maxIterationInstructions?: number;
  /** Growth allowance as a fraction of the function's instructions. Default 0.2. */
  readonly growthRatio?: number;
  /** Floor of the growth allowance. Default 128 instructions. */
  readonly minGrowth?: number;
  /**
   * Explicit growth allowance in instructions; overrides the ratio and floor.
   * The allowance is per function: every unrolled loop consumes its share.
   */
  readonly growthBudget?: number;
  /** Largest trip count the pass considers. Default 64. */
  readonly maxTripCount?: number;
}

interface Settings {
  readonly maxFullIterations: number;
  readonly maxIterationInstructions: number;
  readonly growthRatio: number;
  readonly minGrowth: number;
  readonly growthBudget: number | undefined;
  readonly maxTripCount: number;
}

function resolve(options: UnrollOptions): Settings {
  return {
    maxFullIterations: options.maxFullIterations ?? MAX_FULL_ITERATIONS,
    maxIterationInstructions: options.maxIterationInstructions ?? MAX_ITERATION_INSTRUCTIONS,
    growthRatio: options.growthRatio ?? GROWTH_RATIO,
    minGrowth: options.minGrowth ?? MIN_GROWTH,
    growthBudget: options.growthBudget,
    maxTripCount: options.maxTripCount ?? MAX_TRIP_COUNT,
  };
}

/* -------------------------------------------------------------------------
 * Loop matching
 * ---------------------------------------------------------------------- */

/** One canonical counted loop, with the values needed to unroll it. */
interface LoopShape {
  readonly header: MBlock;
  readonly latch: MBlock;
  readonly preheader: MBlock;
  /** Header → latch edge, always taken while the loop runs. */
  readonly pivot: MEdge;
  /** Header → outside edge, taken when the loop finishes. */
  readonly exit: MEdge;
  /** Arguments the preheader passes to the header (the induction entry state). */
  readonly entryArgs: readonly ValueId[];
  readonly ivIndex: number;
  readonly ivType: ScalarType;
  readonly ivRep: Rep;
  readonly start: number;
  readonly step: number;
  readonly trips: number;
}

function blockOf(blocks: ReadonlyMap<number, MBlock>, id: number): MBlock {
  const block = blocks.get(id);
  if (block === undefined) throw new Error(`MIR unroll failed: unknown block ${id}`);
  return block;
}

/** The instruction that defines `id`, or `undefined` for block parameters. */
function instructionDef(fn: MFunction, id: ValueId): MInst | undefined {
  const def = fn.values[id]?.def;
  if (def === undefined) return undefined;
  return 'op' in def ? def : undefined;
}

/**
 * A constant operand: a literal `const` first, otherwise any integer value the
 * J11 range analysis proves to be a single point (`[c, c]`).
 */
function constantOf(
  fn: MFunction,
  id: ValueId | undefined,
  ranges: ReturnType<typeof analyzeRanges>,
): number | undefined {
  if (id === undefined) return undefined;
  const def = instructionDef(fn, id);
  if (def !== undefined && def.op === Op.Const && typeof def.imm[0] === 'number') {
    return def.imm[0];
  }
  const interval = ranges.values.get(id);
  if (interval === undefined) return undefined;
  if (interval.lo !== interval.hi || !Number.isSafeInteger(interval.lo)) return undefined;
  return interval.lo;
}

interface IntegerBounds {
  readonly min: number;
  readonly max: number;
}

const INTEGER_BOUNDS: Readonly<Record<string, IntegerBounds>> = Object.freeze({
  u8: { min: 0, max: 0xff },
  u16: { min: 0, max: 0xffff },
  u32: { min: 0, max: 0xffff_ffff },
  i8: { min: -0x80, max: 0x7f },
  i16: { min: -0x8000, max: 0x7fff },
  i32: { min: -0x8000_0000, max: 0x7fff_ffff },
});

function inRange(type: ScalarType, value: number): boolean {
  const bounds = INTEGER_BOUNDS[type];
  if (bounds === undefined) return false;
  return Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max;
}

/** Mirrored predicate for `cmp(c, i)` where `i` is the induction variable. */
const MIRRORED: Readonly<Record<string, string | undefined>> = Object.freeze({
  eq: 'eq',
  ne: 'ne',
  lt: 'gt',
  le: 'ge',
  gt: 'lt',
  ge: 'le',
});

/**
 * Number of iterations of `i <predicate> limit` starting at `start` and stepping
 * by `step`, or `undefined` when it is not a terminating counted loop.
 */
function tripCount(
  type: ScalarType,
  predicate: string,
  start: number,
  limit: number,
  step: number,
  maxTrips: number,
): number | undefined {
  if (!inRange(type, start) || !inRange(type, limit)) return undefined;
  const magnitude = Math.abs(step);
  const ascending = step > 0;
  let trips: number;
  if (ascending && predicate === 'lt') {
    trips = start >= limit ? 0 : Math.ceil((limit - start) / magnitude);
  } else if (ascending && predicate === 'le') {
    trips = start > limit ? 0 : Math.floor((limit - start) / magnitude) + 1;
  } else if (!ascending && predicate === 'gt') {
    trips = start <= limit ? 0 : Math.ceil((start - limit) / magnitude);
  } else if (!ascending && predicate === 'ge') {
    trips = start < limit ? 0 : Math.floor((start - limit) / magnitude) + 1;
  } else {
    // `ne`/`eq` bounds are not counted loops, and a step that moves away from
    // the bound never terminates.
    return undefined;
  }
  if (!Number.isSafeInteger(trips) || trips < 0 || trips > maxTrips) return undefined;
  // The last header visit evaluates the induction variable once more; the loop
  // only terminates when that value still fits the type. Otherwise the
  // induction variable wrapped and the count above is meaningless.
  if (!inRange(type, start + trips * step)) return undefined;
  return trips;
}

/**
 * Instructions that keep a loop from being unrolled: host code and control
 * transfer (calls, checkpoints, executors, events, provider bridges), plus the
 * operations that raise a value error at a source location. Plain storage
 * writes stay allowed: the copies run in the original order, so the write
 * sequence is identical, and they are what makes a hot loop worth unrolling.
 */
function blocksUnrolling(inst: MInst): boolean {
  const info = EFFECT_INFO[inst.op];
  if (info === undefined) return true;
  if (info.host || info.transfer) return true;
  if (!info.throws) return false;
  return !(inst.op === Op.StateStore || inst.op === Op.ArrayStore || inst.op === Op.BytesStore);
}

interface Induction {
  readonly ivIndex: number;
  readonly ivType: ScalarType;
  readonly ivRep: Rep;
  readonly start: number;
  readonly step: number;
  readonly trips: number;
}

/** Constant, non-zero increment of `iv` on the back edge. */
function constantStep(
  fn: MFunction,
  arg: ValueId | undefined,
  iv: ValueId,
  ranges: ReturnType<typeof analyzeRanges>,
): number | undefined {
  const def = arg === undefined ? undefined : instructionDef(fn, arg);
  if (def === undefined) return undefined;
  const [left, right] = def.args;
  if (def.op === Op.IntAdd) {
    if (left === iv) return nonzero(constantOf(fn, right, ranges));
    if (right === iv) return nonzero(constantOf(fn, left, ranges));
    return undefined;
  }
  if (def.op === Op.IntSub && left === iv) {
    const step = nonzero(constantOf(fn, right, ranges));
    return step === undefined ? undefined : -step;
  }
  return undefined;
}

function nonzero(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value === 0) return undefined;
  return value;
}

/** Match `i <op> limit` (either operand order), `i +/- c` and the entry value. */
function matchInduction(
  fn: MFunction,
  header: MBlock,
  latch: MBlock,
  pivot: MEdge,
  entryArgs: readonly ValueId[],
  ranges: ReturnType<typeof analyzeRanges>,
  settings: Settings,
): Induction | undefined {
  const term = header.term;
  if (term.kind !== 'branch') return undefined;
  const comparison = instructionDef(fn, term.cond);
  if (comparison === undefined || comparison.op !== Op.IntCmp) return undefined;
  if (!header.insts.includes(comparison)) return undefined;
  const predicate = comparison.imm[0];
  const left = comparison.args[0];
  const right = comparison.args[1];
  if (typeof predicate !== 'string' || left === undefined || right === undefined) {
    return undefined;
  }

  let ivIndex = header.params.indexOf(left);
  let effective = predicate;
  let limitId = right;
  if (ivIndex < 0) {
    ivIndex = header.params.indexOf(right);
    const mirrored = MIRRORED[predicate];
    if (mirrored === undefined) return undefined;
    effective = mirrored;
    limitId = left;
  }
  if (ivIndex < 0) return undefined;
  const iv = header.params[ivIndex]!;
  const ivType = fn.values[iv]!.type;
  if (!isIntegerType(ivType)) return undefined;

  const start = constantOf(fn, entryArgs[ivIndex], ranges);
  const limit = constantOf(fn, limitId, ranges);
  if (start === undefined || limit === undefined) return undefined;
  if (latch.term.kind !== 'jump') return undefined;
  // The back edge computes the next induction value from the latch parameter,
  // which the pivot edge feeds from the header.
  const latchIv = latch.params[ivIndex] ?? pivot.args[ivIndex] ?? iv;
  const step = constantStep(fn, latch.term.args[ivIndex], latchIv, ranges);
  if (step === undefined) return undefined;

  const trips = tripCount(ivType, effective, start, limit, step, settings.maxTripCount);
  if (trips === undefined) return undefined;
  return { ivIndex, ivType, ivRep: fn.values[iv]!.rep, start, step, trips };
}

/** Recognise one canonical counted natural loop, or return `undefined`. */
function matchLoop(
  fn: MFunction,
  analysis: CFGAnalysis,
  blocks: ReadonlyMap<number, MBlock>,
  ranges: ReturnType<typeof analyzeRanges>,
  loop: Loop,
  settings: Settings,
): LoopShape | undefined {
  // Exactly the canonical shape: header + one latch, no inner structure.
  if (loop.blocks.size !== 2 || loop.latches.length !== 1) return undefined;
  if (loop.exits.length !== 1) return undefined;
  const header = blockOf(blocks, loop.header);
  const latch = blockOf(blocks, loop.latches[0]!);
  if (header.term.kind !== 'branch') return undefined;
  if (latch.term.kind !== 'jump' || latch.term.target !== header.id) return undefined;
  if (loop.exits[0]!.from !== header.id) return undefined;

  const yesInside = loop.blocks.has(header.term.yes.target);
  const noInside = loop.blocks.has(header.term.no.target);
  if (yesInside === noInside) return undefined;
  const pivot = yesInside ? header.term.yes : header.term.no;
  const exit = yesInside ? header.term.no : header.term.yes;
  if (pivot.target !== latch.id) return undefined;
  if (exit.target !== loop.exits[0]!.to) return undefined;

  // A unique preheader whose only edge enters the header: unrolling inlines the
  // loop, so no block is left to receive parameters from several edges.
  const outside = (analysis.cfg.preds.get(header.id) ?? []).filter((id) => !loop.blocks.has(id));
  if (outside.length !== 1) return undefined;
  const preheader = blockOf(blocks, outside[0]!);
  const preheaderEdges = terminatorEdges(preheader.term);
  if (preheaderEdges.length !== 1 || preheaderEdges[0]!.target !== header.id) return undefined;

  for (const block of [header, latch]) {
    for (const inst of block.insts) if (blocksUnrolling(inst)) return undefined;
  }

  const induction = matchInduction(
    fn,
    header,
    latch,
    pivot,
    preheaderEdges[0]!.args,
    ranges,
    settings,
  );
  if (induction === undefined) return undefined;
  return {
    header,
    latch,
    preheader,
    pivot,
    exit,
    entryArgs: preheaderEdges[0]!.args,
    ...induction,
  };
}

/* -------------------------------------------------------------------------
 * Unroll planning
 * ---------------------------------------------------------------------- */

type UnrollPlan =
  | { readonly kind: 'full'; readonly trips: number; readonly growth: number }
  | {
      readonly kind: 'partial';
      readonly factor: number;
      readonly groups: number;
      readonly growth: number;
    };

function totalInstructions(fn: MFunction): number {
  let total = 0;
  for (const block of fn.blocks) total += block.insts.length;
  return total;
}

/** Steps one traversal of the header accounts for. */
function headerSteps(header: MBlock): number {
  let steps = header.term.step;
  for (const inst of header.insts) steps += inst.step;
  return steps;
}

/**
 * Whether the body can be replicated without re-running the header: every edge
 * argument must come from the header's parameters or from outside the loop.
 */
function replicable(shape: LoopShape): boolean {
  const stable = (id: ValueId): boolean =>
    shape.header.params.includes(id) ||
    !shape.header.insts.some((inst) => inst.results.includes(id));
  return (
    shape.pivot.args.every(stable) &&
    shape.exit.args.every(stable) &&
    shape.latch.term.kind === 'jump' &&
    shape.latch.term.args.every(stable)
  );
}

function planUnroll(
  shape: LoopShape,
  settings: Settings,
  allowance: number,
): UnrollPlan | undefined {
  const perIteration = shape.header.insts.length + shape.latch.insts.length;
  if (perIteration > settings.maxIterationInstructions) return undefined;

  if (shape.trips <= settings.maxFullIterations) {
    // Every trip clones the header and the body; the final header visit clones
    // the header once more.
    const growth =
      (shape.trips + 1) * shape.header.insts.length + shape.trips * shape.latch.insts.length;
    if (growth <= allowance) return { kind: 'full', trips: shape.trips, growth };
  }

  if (!replicable(shape)) return undefined;
  for (const factor of PARTIAL_FACTORS) {
    if (factor < 2 || shape.trips % factor !== 0) continue;
    const groups = shape.trips / factor;
    if (groups < 2) continue;
    // `factor` body copies plus `factor - 1` header step placeholders per group.
    const growth = factor * shape.latch.insts.length + (factor - 1) * headerSteps(shape.header);
    if (growth > allowance) continue;
    return { kind: 'partial', factor, groups, growth };
  }
  return undefined;
}

/* -------------------------------------------------------------------------
 * Unroll application
 * ---------------------------------------------------------------------- */

/** Fresh ids, values and locations for the blocks an unroll introduces. */
class Builder {
  readonly blocks: MBlock[] = [];
  readonly values: MValue[] = [];
  readonly locations: IRExecutionLocation[];
  readonly parent: number[];
  readonly inlineFrames: (MInlineFrame | undefined)[];
  readonly #fn: MFunction;
  #nextBlockId: number;

  constructor(fn: MFunction, firstBlockId: number) {
    this.#fn = fn;
    this.locations = [...fn.locs.locations];
    this.parent = Array.from(fn.locs.parent);
    this.inlineFrames = [...fn.locs.inlineFrames];
    this.#nextBlockId = firstBlockId;
  }

  /** Id the next {@link block} call uses; needed for forward edges. */
  peekId(): number {
    return this.#nextBlockId;
  }

  /**
   * A fresh location id pointing at the same source position. Every copied item
   * needs its own id: `stepsAfter` is indexed by location, so two items sharing
   * one id would corrupt the step count an unwind reports.
   */
  cloneLoc(original: LocId): LocId {
    const id = this.locations.length;
    this.locations.push(this.#fn.locs.locations[original]!);
    this.parent.push(this.#fn.locs.parent[original] ?? -1);
    this.inlineFrames.push(this.#fn.locs.inlineFrames[original]);
    return id;
  }

  block(insts: MInst[], term: MTerm): MBlock {
    const block: MBlock = {
      id: this.#nextBlockId,
      params: [],
      insts,
      term,
      preds: [],
      succs: [],
    };
    this.#nextBlockId += 1;
    this.blocks.push(block);
    return block;
  }

  /** Clone one instruction: fresh results, fresh location, mapped operands. */
  clone(inst: MInst, args: readonly ValueId[]): MInst {
    const copy = copyInst(inst, { args: [...args], results: [], loc: this.cloneLoc(inst.loc) });
    for (const old of inst.results) {
      const original = this.#fn.values[old]!;
      const value: MValue = {
        id: this.#fn.values.length + this.values.length,
        type: original.type,
        rep: original.rep,
        def: copy,
      };
      this.values.push(value);
      copy.results.push(value.id);
    }
    return copy;
  }

  /** A synthetic constant (step 0) standing in for a known induction value. */
  constant(type: ScalarType, rep: Rep, value: number, loc: LocId): MInst {
    const id = this.#fn.values.length + this.values.length;
    const inst: MInst = {
      op: Op.Const,
      args: [],
      results: [id],
      imm: [Object.is(value, -0) ? 0 : value],
      refs: [],
      node: undefined,
      loc: this.cloneLoc(loc),
      step: 0,
    };
    this.values.push({ id, type, rep, def: inst });
    return inst;
  }

  /** A synthetic `Check(none)` that accounts for one source step. */
  check(step: 0 | 1, loc: LocId): MInst {
    return {
      op: Op.Check,
      args: [],
      results: [],
      imm: ['none'],
      refs: [],
      node: undefined,
      loc: this.cloneLoc(loc),
      step,
    };
  }

  jump(target: number, args: ValueId[], like: MTerm): MTerm {
    return { kind: 'jump', target, args, loc: this.cloneLoc(like.loc), step: like.step };
  }

  /** Extend the function with the new blocks and renumber its values. */
  finish(blocks: readonly MBlock[]): MFunction {
    const extended: MFunction = {
      ...this.#fn,
      values: [...this.#fn.values, ...this.values],
      locs: {
        locations: Object.freeze(this.locations),
        stepsAfter: extendInt32(this.#fn.locs.stepsAfter, this.locations.length),
        parent: Int32Array.from(this.parent),
        inlineFrames: Object.freeze(this.inlineFrames),
      },
    };
    return rebuildFunction(extended, blocks).fn;
  }
}

function extendInt32(original: Int32Array, length: number): Int32Array {
  const next = new Int32Array(length).fill(-1);
  next.set(original.subarray(0, Math.min(original.length, length)));
  return next;
}

function mapValue(sigma: ReadonlyMap<ValueId, ValueId>, id: ValueId): ValueId {
  return sigma.get(id) ?? id;
}

function mapArgs(sigma: ReadonlyMap<ValueId, ValueId>, args: readonly ValueId[]): ValueId[] {
  return args.map((id) => mapValue(sigma, id));
}

/** Record the fresh results of a cloned instruction in the substitution. */
function record(sigma: Map<ValueId, ValueId>, original: MInst, copy: MInst): void {
  original.results.forEach((old, index) => sigma.set(old, copy.results[index]!));
}

/** Point every edge that targeted `from` at `to`, dropping its arguments. */
function redirect(block: MBlock, from: number, to: number): MBlock {
  const term = block.term;
  const edge = (candidate: MEdge): MEdge =>
    candidate.target === from ? { target: to, args: [] } : copyEdge(candidate);
  let next: MTerm;
  switch (term.kind) {
    case 'jump':
      next = term.target === from ? { ...term, target: to, args: [] } : copyTerm(term);
      break;
    case 'branch':
      next = { ...term, yes: edge(term.yes), no: edge(term.no) };
      break;
    default:
      next = copyTerm(term);
      break;
  }
  return { ...block, params: [...block.params], insts: [...block.insts], term: next };
}

/** Fully unroll: `trips` copies of `header; body` plus the final header visit. */
function applyFull(fn: MFunction, shape: LoopShape, builder: Builder, trips: number): MFunction {
  const { header, latch, pivot, exit, entryArgs, ivIndex, ivType, ivRep, start, step } = shape;
  const headerTerm = header.term;
  const latchTerm = latch.term;
  if (headerTerm.kind !== 'branch' || latchTerm.kind !== 'jump') {
    throw new Error('MIR unroll failed: loop shape changed while unrolling');
  }
  const first = builder.peekId();
  const target = (index: number): number => first + index;

  let sigma = new Map<ValueId, ValueId>();
  header.params.forEach((param, index) => sigma.set(param, entryArgs[index] ?? param));

  /** Clone one header visit; the induction variable is its known constant. */
  const headerVisit = (induction: number): MInst[] => {
    const constant = builder.constant(ivType, ivRep, induction, headerTerm.loc);
    sigma.set(header.params[ivIndex]!, constant.results[0]!);
    const insts: MInst[] = [constant];
    for (const inst of header.insts) {
      const copy = builder.clone(inst, mapArgs(sigma, inst.args));
      record(sigma, inst, copy);
      insts.push(copy);
    }
    return insts;
  };

  for (let iteration = 0; iteration < trips; iteration += 1) {
    const insts = headerVisit(start + iteration * step);
    // The branch is statically taken; its step still has to be counted.
    if (headerTerm.step === 1) insts.push(builder.check(1, headerTerm.loc));
    // The body's parameters receive the pivot edge arguments of this iteration.
    latch.params.forEach((param, index) =>
      sigma.set(param, mapValue(sigma, pivot.args[index] ?? param)),
    );
    for (const inst of latch.insts) {
      const copy = builder.clone(inst, mapArgs(sigma, inst.args));
      record(sigma, inst, copy);
      insts.push(copy);
    }
    const next = new Map<ValueId, ValueId>();
    header.params.forEach((param, index) =>
      next.set(param, mapValue(sigma, latchTerm.args[index] ?? param)),
    );
    builder.block(insts, builder.jump(target(iteration + 1), [], latchTerm));
    sigma = next;
  }

  // Final header visit: the condition is false, so control leaves the loop.
  const finalInsts = headerVisit(start + trips * step);
  builder.block(finalInsts, {
    kind: 'jump',
    target: exit.target,
    args: mapArgs(sigma, exit.args),
    loc: builder.cloneLoc(headerTerm.loc),
    step: headerTerm.step,
  });

  const blocks = fn.blocks.map((block) =>
    block.id === shape.preheader.id ? redirect(block, header.id, first) : block,
  );
  return builder.finish([...blocks, ...builder.blocks]);
}

/** Partially unroll: `factor` latch bodies per loop iteration. */
function applyPartial(
  fn: MFunction,
  shape: LoopShape,
  builder: Builder,
  factor: number,
): MFunction {
  const { header, latch, pivot } = shape;
  const headerTerm = header.term;
  const latchTerm = latch.term;
  if (headerTerm.kind !== 'branch' || latchTerm.kind !== 'jump') {
    throw new Error('MIR unroll failed: loop shape changed while unrolling');
  }
  const first = builder.peekId();
  const target = (index: number): number => first + index;

  /** Step placeholders for one header visit this group replaces. */
  const placeholders = (): MInst[] => {
    const insts: MInst[] = [];
    for (const inst of header.insts) if (inst.step === 1) insts.push(builder.check(1, inst.loc));
    if (headerTerm.step === 1) insts.push(builder.check(1, headerTerm.loc));
    return insts;
  };

  let sigma = new Map<ValueId, ValueId>();
  for (let copy = 0; copy < factor; copy += 1) {
    if (copy > 0) {
      // Thread the header parameters through the previous copy's back edge.
      const next = new Map<ValueId, ValueId>();
      header.params.forEach((param, index) =>
        next.set(param, mapValue(sigma, latchTerm.args[index] ?? param)),
      );
      sigma = next;
    }
    const insts = copy === 0 ? [] : placeholders();
    // The replicated body starts from this iteration's pivot arguments.
    latch.params.forEach((param, index) =>
      sigma.set(param, mapValue(sigma, pivot.args[index] ?? param)),
    );
    for (const inst of latch.insts) {
      const cloned = builder.clone(inst, mapArgs(sigma, inst.args));
      record(sigma, inst, cloned);
      insts.push(cloned);
    }
    const last = copy === factor - 1;
    builder.block(
      insts,
      builder.jump(
        last ? header.id : target(copy + 1),
        last ? mapArgs(sigma, latchTerm.args) : [],
        latchTerm,
      ),
    );
  }

  const blocks = fn.blocks.map((block) => {
    if (block.id !== header.id) return block;
    // The header's pivot edge now enters the first replicated body; the header
    // itself stays the loop entry, so its step accounting is unchanged.
    const term: MTerm =
      headerTerm.yes.target === latch.id
        ? { ...headerTerm, yes: { target: first, args: [] }, no: copyEdge(headerTerm.no) }
        : { ...headerTerm, yes: copyEdge(headerTerm.yes), no: { target: first, args: [] } };
    return { ...block, params: [...block.params], insts: [...block.insts], term };
  });
  return builder.finish([...blocks, ...builder.blocks]);
}

/* -------------------------------------------------------------------------
 * Pass entry point
 * ---------------------------------------------------------------------- */

/**
 * Select the innermost loop the size policy accepts. Loops whose shape matches
 * but whose plan is rejected are marked as processed so the caller does not
 * retry them forever.
 */
function select(
  fn: MFunction,
  analysis: CFGAnalysis,
  blocks: ReadonlyMap<number, MBlock>,
  ranges: ReturnType<typeof analyzeRanges>,
  processed: Set<number>,
  settings: Settings,
  allowance: number,
): { readonly shape: LoopShape; readonly plan: UnrollPlan } | undefined {
  const order = [...analysis.loops].sort(
    (left, right) => right.depth - left.depth || left.header - right.header,
  );
  for (const loop of order) {
    if (processed.has(loop.header)) continue;
    const shape = matchLoop(fn, analysis, blocks, ranges, loop, settings);
    if (shape === undefined) continue;
    processed.add(loop.header);
    const plan = planUnroll(shape, settings, allowance);
    if (plan !== undefined) return { shape, plan };
  }
  return undefined;
}

/**
 * Unroll the small counted loops of one function. The input is never mutated; a
 * function without an unrollable loop is returned unchanged.
 *
 * The growth allowance is computed once from the function's size and consumed
 * by every unrolled loop, so the copies of many loops cannot compound.
 */
export function optimizeFunction(fn: MFunction, options: UnrollOptions = {}): MFunction {
  const settings = resolve(options);
  let allowance =
    settings.growthBudget ??
    Math.max(settings.minGrowth, Math.ceil(totalInstructions(fn) * settings.growthRatio));
  let current = fn;
  const processed = new Set<number>();
  for (;;) {
    const analysis = analyzeCFG(current);
    if (!analysis.reducible) return current;
    const blocks = blockMap(current);
    const ranges = analyzeRanges(current);
    const chosen = select(current, analysis, blocks, ranges, processed, settings, allowance);
    if (chosen === undefined) return current;
    allowance -= chosen.plan.growth;
    const builder = new Builder(current, freshBlockId(current));
    current =
      chosen.plan.kind === 'full'
        ? applyFull(current, chosen.shape, builder, chosen.plan.trips)
        : applyPartial(current, chosen.shape, builder, chosen.plan.factor);
  }
}
