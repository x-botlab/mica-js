/**
 * Function inlining and tier-2 layout hints (J13).
 *
 * The pass copies small, non-transferring callees into their call sites. It is
 * deliberately independent from code generation:
 *
 * - the original `call` instruction (which ends a step segment) is replaced by
 *   an `Op.Check` with the same `step = 1` that no longer ends a segment;
 * - a synthetic `jump` (`step = 0`) enters the copied callee entry block;
 * - every copied `return` (`step = 1`) becomes a `jump` to the continuation
 *   block, with the returned values passed as block parameters.
 *
 * The step count along any path is therefore identical to the reference
 * interpreter: `call` (1) + callee body + `return` (1). Callees that contain a
 * provider `dispatch` or a `checkpoint` are never inlined: their tail-transfer
 * frame replacement cannot be reproduced inside a caller.
 *
 * Every copied location keeps the callee's original location object and gets a
 * fresh `LocId` whose `parent` points at the call site. `JitRuntime.unwind`
 * walks that chain, so `IRExecutionError.callStack` lists the same frames as an
 * unoptimized run, one layer at a time.
 */
import { isIntegerType } from '../../runtime';
import type { IRExecutionLocation } from '../../interpreter';
import type { ScalarType } from '../../types';
import type { FunctionSummary } from '../effects';
import { buildCFG, computeDominators, findLoops } from '../cfg';
import { Op } from '../mir';
import type {
  LayoutProfile,
  LocId,
  MBlock,
  MEdge,
  MFunction,
  MInlineFrame,
  MInst,
  MPromotion,
  MTerm,
  Rep,
  ValueId,
} from '../mir';

/** Invocation counts collected by tier-1, used to rank call sites. */
export interface InlineProfile {
  /** Callee function index -> number of tier-1 invocations. */
  readonly calls: ReadonlyMap<number, number>;
}

export interface InlineOptions {
  /** Largest callee (MIR instruction count) eligible for inlining. Default 120. */
  readonly maxInstructions?: number;
  /** Growth budget multiplier applied to the caller's original instruction count. Default 4. */
  readonly growthFactor?: number;
  /** Constant part of the growth budget. Default 200. */
  readonly growthAllowance?: number;
  /** Maximum nesting depth of inlined frames. Default 4. */
  readonly maxDepth?: number;
  /** Optional tier-1 profile; hotter callees are inlined first. */
  readonly profile?: InlineProfile;
}

export interface InlineContext {
  /** Every model function, indexed by `functionIndex`, available as a callee. */
  readonly functions: readonly MFunction[];
  readonly summaries?: ReadonlyMap<number, FunctionSummary>;
  /** Precomputed call-graph SCC ids (see {@link createInlineContext}). */
  readonly scc?: ReadonlyMap<number, number>;
}

export interface InlineResult {
  readonly fn: MFunction;
  /** Block weights for tier-2 biased layout; higher is hotter. */
  readonly layout: LayoutProfile;
  /** Number of call sites that were inlined. */
  readonly inlined: number;
}

const DEFAULT_MAX_INSTRUCTIONS = 120;
const DEFAULT_GROWTH_FACTOR = 4;
const DEFAULT_GROWTH_ALLOWANCE = 200;
const DEFAULT_MAX_DEPTH = 4;

interface ResolvedInlineOptions {
  readonly maxInstructions: number;
  readonly growthFactor: number;
  readonly growthAllowance: number;
  readonly maxDepth: number;
  readonly profile: InlineProfile | undefined;
}

function resolveOptions(options: InlineOptions): ResolvedInlineOptions {
  return {
    maxInstructions: options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS,
    growthFactor: options.growthFactor ?? DEFAULT_GROWTH_FACTOR,
    growthAllowance: options.growthAllowance ?? DEFAULT_GROWTH_ALLOWANCE,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    profile: options.profile,
  };
}

function callTargets(fn: MFunction): number[] {
  const targets: number[] = [];
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      const target = inst.op === Op.Call ? inst.refs[0] : undefined;
      if (target !== undefined) targets.push(target);
    }
  }
  return targets;
}

/**
 * Strongly connected components of the model call graph (Kosaraju).
 *
 * A call is only inlined when caller and callee belong to different
 * components, which rules out direct and mutual recursion without a separate
 * recursion check.
 */
function computeSccs(functions: readonly MFunction[]): Map<number, number> {
  const nodes = new Set(functions.map((fn) => fn.functionIndex));
  const adjacency = new Map<number, number[]>();
  for (const fn of functions) {
    adjacency.set(fn.functionIndex, [
      ...new Set(callTargets(fn).filter((target) => nodes.has(target))),
    ]);
  }

  const visited = new Set<number>();
  const order: number[] = [];
  for (const fn of functions) {
    const start = fn.functionIndex;
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: { readonly id: number; index: number }[] = [{ id: start, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const successors = adjacency.get(frame.id) ?? [];
      if (frame.index < successors.length) {
        const successor = successors[frame.index]!;
        frame.index += 1;
        if (!visited.has(successor)) {
          visited.add(successor);
          stack.push({ id: successor, index: 0 });
        }
        continue;
      }
      order.push(frame.id);
      stack.pop();
    }
  }

  const reverse = new Map<number, number[]>();
  for (const node of nodes) reverse.set(node, []);
  for (const [from, targets] of adjacency) {
    for (const to of targets) reverse.get(to)!.push(from);
  }

  const component = new Map<number, number>();
  let nextComponent = 0;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const start = order[index]!;
    if (component.has(start)) continue;
    const id = nextComponent;
    nextComponent += 1;
    component.set(start, id);
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const predecessor of reverse.get(current) ?? []) {
        if (component.has(predecessor)) continue;
        component.set(predecessor, id);
        stack.push(predecessor);
      }
    }
  }
  return component;
}

/** Precompute the callee table and SCC map shared by several `inlineFunction` calls. */
export function createInlineContext(
  functions: readonly MFunction[],
  summaries?: ReadonlyMap<number, FunctionSummary>,
): InlineContext {
  return {
    functions,
    ...(summaries === undefined ? {} : { summaries }),
    scc: computeSccs(functions),
  };
}

function initialRep(type: ScalarType): Rep {
  if (type === 'bool') return 'bool';
  return isIntegerType(type) ? 'int' : 'U';
}

function isPromotionRefOp(op: Op): boolean {
  return (
    op === Op.Spill || op === Op.PromoteLoad || op === Op.PromoteStore || op === Op.PromoteReload
  );
}

interface Candidate {
  readonly blockId: number;
  readonly instIndex: number;
  readonly inst: MInst;
  readonly callee: MFunction;
  readonly calleeSize: number;
  readonly hotness: number;
  readonly loopDepth: number;
}

function instructionCount(blocks: readonly MBlock[]): number {
  let count = 0;
  for (const block of blocks) count += block.insts.length;
  return count;
}

class InlineBuilder {
  readonly #fn: MFunction;
  readonly #functions: ReadonlyMap<number, MFunction>;
  readonly #summaries: ReadonlyMap<number, FunctionSummary> | undefined;
  readonly #scc: ReadonlyMap<number, number>;
  readonly #options: ResolvedInlineOptions;
  readonly #blockOwners = new Map<number, number>();
  readonly #blockDepths = new Map<number, number>();
  readonly #baseWeights = new Map<number, number>();

  #blocks: MBlock[];
  readonly #valueTypes: ScalarType[];
  readonly #valueReps: Rep[];
  readonly #locations: IRExecutionLocation[];
  readonly #parents: number[];
  readonly #inlineFrames: (MInlineFrame | undefined)[];
  readonly #promotions: MPromotion[];
  #nextBlock: number;
  #nextValue: number;
  #size: number;
  #inlined = 0;

  constructor(fn: MFunction, context: InlineContext, options: InlineOptions) {
    this.#fn = fn;
    this.#functions = new Map(context.functions.map((callee) => [callee.functionIndex, callee]));
    this.#summaries = context.summaries;
    this.#scc = context.scc ?? computeSccs(context.functions);
    this.#options = resolveOptions(options);

    this.#blocks = fn.blocks.map((block) => ({
      id: block.id,
      params: [...block.params],
      insts: block.insts,
      term: block.term,
      preds: [],
      succs: [],
    }));
    this.#valueTypes = fn.values.map((value) => value.type);
    this.#valueReps = fn.values.map((value) => value.rep);
    this.#locations = [...fn.locs.locations];
    this.#parents = Array.from(fn.locs.parent);
    this.#inlineFrames = [...fn.locs.inlineFrames];
    this.#promotions = fn.promotions.map((promotion) => ({ ...promotion }));
    this.#nextValue = this.#valueTypes.length;
    this.#nextBlock = 1 + Math.max(...fn.blocks.map((block) => block.id));
    this.#size = instructionCount(fn.blocks);

    for (const block of fn.blocks) {
      this.#blockOwners.set(block.id, fn.functionIndex);
      this.#blockDepths.set(block.id, 0);
      this.#baseWeights.set(block.id, 1);
    }
  }

  run(): InlineResult {
    const budget =
      instructionCount(this.#fn.blocks) * this.#options.growthFactor +
      this.#options.growthAllowance;
    for (;;) {
      const candidate = this.#candidates().find((entry) => this.#size + entry.calleeSize <= budget);
      if (candidate === undefined) break;
      this.#inlineOne(candidate);
    }
    return this.#build();
  }

  // --- Candidate selection ----------------------------------------------

  #snapshot(): MFunction {
    return { ...this.#fn, blocks: this.#blocks, values: this.#fn.values };
  }

  #candidates(): Candidate[] {
    if (this.#options.maxInstructions <= 0 || this.#options.maxDepth <= 0) return [];
    const snapshot = this.#snapshot();
    const cfg = buildCFG(snapshot);
    const reachable = new Set(cfg.order);
    const dominators = computeDominators(cfg);
    const loops = findLoops(cfg, dominators);
    const loopDepths = new Map<number, number>();
    for (const loop of loops) {
      for (const id of loop.blocks) {
        loopDepths.set(id, Math.max(loopDepths.get(id) ?? 0, loop.depth + 1));
      }
    }

    const candidates: Candidate[] = [];
    for (const block of this.#blocks) {
      if (!reachable.has(block.id)) continue;
      const depth = this.#blockDepths.get(block.id) ?? 0;
      if (depth >= this.#options.maxDepth) continue;
      const owner = this.#blockOwners.get(block.id) ?? this.#fn.functionIndex;
      const ownerComponent = this.#scc.get(owner);
      const loopDepth = loopDepths.get(block.id) ?? 0;
      block.insts.forEach((inst, instIndex) => {
        if (inst.op !== Op.Call) return;
        const target = inst.refs[0];
        if (target === undefined) return;
        const callee = this.#functions.get(target);
        if (callee === undefined) return;
        // Never inline recursion (same SCC) or a callee that can transfer
        // control to a provider artifact.
        const calleeComponent = this.#scc.get(target);
        if (ownerComponent !== undefined && calleeComponent !== undefined) {
          if (ownerComponent === calleeComponent) return;
        }
        // The specification forbids inlining a recursive callee even when the
        // caller itself is not recursive: only its outer frame would disappear,
        // which is not worth the code growth.
        if (this.#recursive(callee)) return;
        if (this.#transfers(callee)) return;
        const calleeSize = instructionCount(callee.blocks);
        if (calleeSize > this.#options.maxInstructions) return;
        if (!this.#signatureMatches(inst, callee)) return;
        candidates.push({
          blockId: block.id,
          instIndex,
          inst,
          callee,
          calleeSize,
          hotness: this.#options.profile?.calls.get(target) ?? 0,
          loopDepth,
        });
      });
    }

    // Hot call sites first, then the statically deepest (innermost) loop, then
    // the smallest callee. The final keys keep the result deterministic.
    candidates.sort(
      (left, right) =>
        right.hotness - left.hotness ||
        right.loopDepth - left.loopDepth ||
        left.calleeSize - right.calleeSize ||
        left.blockId - right.blockId ||
        left.instIndex - right.instIndex,
    );
    return candidates;
  }

  #recursive(callee: MFunction): boolean {
    const summary = this.#summaries?.get(callee.functionIndex);
    if (summary !== undefined) return summary.recursive;
    const component = this.#scc.get(callee.functionIndex);
    if (component === undefined) return false;
    return callTargets(callee).some((target) => this.#scc.get(target) === component);
  }

  #transfers(callee: MFunction): boolean {
    const summary = this.#summaries?.get(callee.functionIndex);
    if (summary !== undefined) return summary.hasTransfer;
    // Without summaries, inspect the MIR directly instead of assuming it is safe.
    return callee.blocks.some(
      (block) =>
        block.term.kind === 'dispatch' || block.insts.some((inst) => inst.op === Op.Checkpoint),
    );
  }

  #signatureMatches(inst: MInst, callee: MFunction): boolean {
    if (inst.args.length !== callee.params.length) return false;
    if (inst.results.length !== callee.results.length) return false;
    for (let index = 0; index < inst.args.length; index += 1) {
      if (this.#valueTypes[inst.args[index]!] !== callee.params[index]) return false;
    }
    for (let index = 0; index < inst.results.length; index += 1) {
      if (this.#valueTypes[inst.results[index]!] !== callee.results[index]) return false;
    }
    return true;
  }

  // --- Transformation ----------------------------------------------------

  #newValue(type: ScalarType): ValueId {
    const id = this.#nextValue;
    this.#nextValue += 1;
    this.#valueTypes.push(type);
    this.#valueReps.push(initialRep(type));
    return id;
  }

  #inlineOne(candidate: Candidate): void {
    const block = this.#blocks.find((entry) => entry.id === candidate.blockId);
    if (block === undefined) return;
    const call = block.insts[candidate.instIndex];
    if (call === undefined || call.op !== Op.Call) return;
    const callee = candidate.callee;
    const callLoc = call.loc;
    const owner = this.#blockOwners.get(block.id) ?? this.#fn.functionIndex;
    const callerDepth = this.#blockDepths.get(block.id) ?? 0;
    const callerWeight = this.#baseWeights.get(block.id) ?? 1;

    // 1. Fresh values for every callee parameter and instruction result.
    const valueMap = new Map<ValueId, ValueId>();
    for (const calleeBlock of callee.blocks) {
      for (const param of calleeBlock.params) {
        valueMap.set(param, this.#newValue(callee.values[param]!.type));
      }
      for (const inst of calleeBlock.insts) {
        for (const result of inst.results) {
          valueMap.set(result, this.#newValue(callee.values[result]!.type));
        }
      }
    }
    const mapValue = (id: ValueId): ValueId => {
      const mapped = valueMap.get(id);
      if (mapped === undefined) {
        throw new Error(`inline pass: callee v${id} has no definition`);
      }
      return mapped;
    };

    // 2. Copy the callee location table. Each copied loc keeps the callee's
    //    source location object and gains a virtual frame chain.
    const locBase = this.#locations.length;
    const locMap = new Map<LocId, LocId>();
    callee.locs.locations.forEach((location, index) => {
      locMap.set(index, locBase + index);
      const originalParent = callee.locs.parent[index] ?? -1;
      this.#locations.push(location);
      this.#parents.push(originalParent < 0 ? callLoc : locBase + originalParent);
      const inherited = callee.locs.inlineFrames[index];
      this.#inlineFrames.push(inherited ?? frameFor(location));
    });
    const mapLoc = (loc: LocId): LocId => {
      const mapped = locMap.get(loc);
      if (mapped === undefined) throw new Error(`inline pass: callee loc ${loc} was not copied`);
      return mapped;
    };

    // 3. Merge the callee's promoted locals; only Spill/Promote* refs are
    //    promotion indices.
    const promotionMap = new Map<number, number>();
    for (const promotion of callee.promotions) {
      const id = this.#promotions.length;
      promotionMap.set(promotion.id, id);
      this.#promotions.push({ ...promotion, id });
    }

    // 4. Allocate block ids and copy the body. Every return becomes a jump to
    //    the continuation block (created below).
    const continuationId = this.#nextBlock;
    this.#nextBlock += 1;
    const blockIds = new Map<number, number>();
    for (const calleeBlock of callee.blocks) {
      blockIds.set(calleeBlock.id, this.#nextBlock);
      this.#nextBlock += 1;
    }
    const mapBlock = (id: number): number => {
      const mapped = blockIds.get(id);
      if (mapped === undefined) throw new Error(`inline pass: callee block ${id} is missing`);
      return mapped;
    };
    const edge = (entry: MEdge): MEdge => ({
      target: mapBlock(entry.target),
      args: entry.args.map(mapValue),
    });
    const depth = callerDepth + 1;
    const weight = callerWeight + 1 + Math.min(candidate.hotness, 1_000);

    for (const calleeBlock of callee.blocks) {
      const insts = calleeBlock.insts.map((inst) =>
        this.#copyInst(inst, mapValue, mapLoc, promotionMap),
      );
      const term = cloneTerm(calleeBlock.term, {
        mapValue,
        mapLoc,
        mapBlock,
        edge,
        continuation: continuationId,
      });
      const copied: MBlock = {
        id: mapBlock(calleeBlock.id),
        params: calleeBlock.params.map(mapValue),
        insts,
        term,
        preds: [],
        succs: [],
      };
      this.#blocks.push(copied);
      this.#blockOwners.set(copied.id, callee.functionIndex);
      this.#blockDepths.set(copied.id, depth);
      this.#baseWeights.set(copied.id, weight);
    }

    // 5. Split the caller block. The call keeps its one source step as a
    //    non-host `check`; a synthetic step-0 jump enters the copied body.
    const continuation: MBlock = {
      id: continuationId,
      params: [...call.results],
      insts: block.insts.slice(candidate.instIndex + 1),
      term: block.term,
      preds: [],
      succs: [],
    };
    this.#blocks.push(continuation);
    this.#blockOwners.set(continuationId, owner);
    this.#blockDepths.set(continuationId, callerDepth);
    this.#baseWeights.set(continuationId, callerWeight);

    const entryTarget = mapBlock(callee.blocks[0]!.id);
    block.insts = [
      ...block.insts.slice(0, candidate.instIndex),
      {
        op: Op.Check,
        args: [],
        results: [],
        imm: ['none'],
        refs: [],
        node: call.node,
        loc: call.loc,
        step: 1,
      },
    ];
    block.term = {
      kind: 'jump',
      target: entryTarget,
      args: [...call.args],
      loc: callLoc,
      step: 0,
    };

    this.#size += candidate.calleeSize;
    this.#inlined += 1;
  }

  #copyInst(
    inst: MInst,
    mapValue: (id: ValueId) => ValueId,
    mapLoc: (loc: LocId) => LocId,
    promotionMap: ReadonlyMap<number, number>,
  ): MInst {
    const refs = isPromotionRefOp(inst.op)
      ? inst.refs.map((ref) => {
          const mapped = promotionMap.get(ref);
          if (mapped === undefined) {
            throw new Error(`inline pass: ${inst.op} references unknown promotion ${ref}`);
          }
          return mapped;
        })
      : [...inst.refs];
    const copy: MInst = {
      op: inst.op,
      args: inst.args.map(mapValue),
      results: inst.results.map(mapValue),
      imm: [...inst.imm],
      refs,
      node: inst.node,
      loc: mapLoc(inst.loc),
      step: inst.step,
    };
    if (inst.listSplit !== undefined) copy.listSplit = [...inst.listSplit];
    if (inst.constRep !== undefined) copy.constRep = inst.constRep;
    if (inst.uncheckedBounds !== undefined) copy.uncheckedBounds = inst.uncheckedBounds;
    return copy;
  }

  // --- Assembly ----------------------------------------------------------

  #build(): InlineResult {
    const definitions = new Array<MInst | MBlock>(this.#valueTypes.length);
    for (const block of this.#blocks) {
      for (const param of block.params) definitions[param] = block;
      for (const inst of block.insts) {
        for (const result of inst.results) definitions[result] = inst;
      }
    }
    const values = this.#valueTypes.map((type, id) => {
      const def = definitions[id];
      if (def === undefined) throw new Error(`inline pass: v${id} has no definition`);
      return { id, type, rep: this.#valueReps[id]!, def };
    });

    const fn: MFunction = {
      ...this.#fn,
      blocks: this.#blocks,
      values,
      locs: {
        locations: Object.freeze(this.#locations),
        stepsAfter: new Int32Array(this.#locations.length).fill(-1),
        parent: Int32Array.from(this.#parents),
        inlineFrames: Object.freeze(this.#inlineFrames),
      },
      reducible: true,
      promotions: this.#promotions,
      ...(this.#inlined > 0 ? { inlined: true } : {}),
    };

    // Bias tier-2 layout by inline nesting and static loop depth. Runtime
    // profiles only affect the order in which call sites are chosen; the
    // block weights make the hottest inlined region fall through first.
    const loopDepths = loopDepthsFor(fn);
    const blockWeights = new Map<number, number>();
    for (const block of this.#blocks) {
      const base = this.#baseWeights.get(block.id) ?? 1;
      const loopDepth = loopDepths.get(block.id) ?? 0;
      blockWeights.set(block.id, base * (1 + loopDepth) * 10 + Math.min(block.insts.length, 9));
    }
    return { fn, layout: { blockWeights }, inlined: this.#inlined };
  }
}

function frameFor(location: IRExecutionLocation): MInlineFrame {
  return {
    functionIndex: location.functionIndex,
    blockIndex: location.blockIndex,
    ...(location.instructionIndex !== undefined
      ? { instructionIndex: location.instructionIndex }
      : { terminator: true as const }),
  };
}

function loopDepthsFor(fn: MFunction): Map<number, number> {
  const cfg = buildCFG(fn);
  const dominators = computeDominators(cfg);
  const loops = findLoops(cfg, dominators);
  const depths = new Map<number, number>();
  for (const loop of loops) {
    for (const id of loop.blocks) {
      depths.set(id, Math.max(depths.get(id) ?? 0, loop.depth + 1));
    }
  }
  return depths;
}

interface TermMapping {
  readonly mapValue: (id: ValueId) => ValueId;
  readonly mapLoc: (loc: LocId) => LocId;
  readonly mapBlock: (id: number) => number;
  readonly edge: (edge: MEdge) => MEdge;
  readonly continuation: number;
}

/** Clone a callee terminator; `return` becomes a jump to the continuation. */
function cloneTerm(term: MTerm, map: TermMapping): MTerm {
  switch (term.kind) {
    case 'jump':
      return {
        kind: 'jump',
        target: map.mapBlock(term.target),
        args: term.args.map(map.mapValue),
        loc: map.mapLoc(term.loc),
        step: term.step,
      };
    case 'branch':
      return {
        kind: 'branch',
        cond: map.mapValue(term.cond),
        yes: map.edge(term.yes),
        no: map.edge(term.no),
        loc: map.mapLoc(term.loc),
        step: term.step,
      };
    case 'return':
      return {
        kind: 'jump',
        target: map.continuation,
        args: term.values.map(map.mapValue),
        loc: map.mapLoc(term.loc),
        step: term.step,
      };
    case 'dispatch':
      return {
        kind: 'dispatch',
        provider: term.provider,
        key: term.key.map(map.mapValue),
        args: term.args.map(map.mapValue),
        loc: map.mapLoc(term.loc),
        step: term.step,
      };
    case 'trap':
      return { kind: 'trap', code: term.code, loc: map.mapLoc(term.loc), step: term.step };
  }
}

/** Inline one function. */
export function inlineFunction(
  fn: MFunction,
  context: InlineContext,
  options: InlineOptions = {},
): InlineResult {
  return new InlineBuilder(fn, context, options).run();
}

/** Inline every function in a module-sized set and return the results in order. */
export function inlineFunctions(
  functions: readonly MFunction[],
  options: InlineOptions = {},
  summaries?: ReadonlyMap<number, FunctionSummary>,
): readonly InlineResult[] {
  const context = createInlineContext(functions, summaries);
  return functions.map((fn) => inlineFunction(fn, context, options));
}
