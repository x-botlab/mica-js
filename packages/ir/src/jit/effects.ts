/**
 * Instruction effects and function summaries for MIR (J5).
 *
 * Every opcode has a static description: whether it can throw, which storage
 * it reads or writes, whether it enters host code and whether it can transfer
 * control (`checkpoint` / `dispatch`). Function summaries combine those
 * descriptions over the call graph with a least-fixed-point iteration in
 * reverse topological SCC order.
 */
import { isFloatType } from '../runtime';
import { Op } from './mir';
import type { MFunction, MInst, Rep } from './mir';
import { analyzeRepresentation } from './repr';

/** The eight observable effects tracked by the JIT. */
export enum Effect {
  MemoryRead = 'memory-read',
  MemoryWrite = 'memory-write',
  ScalarRead = 'scalar-read',
  ScalarWrite = 'scalar-write',
  Event = 'event',
  Output = 'output',
  VersionedRead = 'versioned-read',
  Throws = 'throws',
}

/** Canonical effect order, used for every reported effect list. */
const EFFECT_ORDER: readonly Effect[] = [
  Effect.MemoryRead,
  Effect.MemoryWrite,
  Effect.ScalarRead,
  Effect.ScalarWrite,
  Effect.Event,
  Effect.Output,
  Effect.VersionedRead,
  Effect.Throws,
];

/** Static description of one opcode. */
export interface EffectInfo {
  /** Complete effect set, in canonical order. */
  readonly effects: readonly Effect[];
  /** Storage reads (`memory-read`, `scalar-read`, `versioned-read`). */
  readonly reads: readonly Effect[];
  /** Storage writes (`memory-write`, `scalar-write`). */
  readonly writes: readonly Effect[];
  readonly throws: boolean;
  /** Enters host code (executor, event host, bridge, provider generation). */
  readonly host: boolean;
  /** Can leave the current function without a normal return (`checkpoint`). */
  readonly transfer: boolean;
}

function info(options: {
  readonly throws?: boolean;
  readonly reads?: readonly Effect[];
  readonly writes?: readonly Effect[];
  readonly host?: boolean;
  readonly transfer?: boolean;
  readonly extra?: readonly Effect[];
}): EffectInfo {
  const set = new Set<Effect>(options.extra ?? []);
  if (options.throws === true) set.add(Effect.Throws);
  for (const effect of options.reads ?? []) set.add(effect);
  for (const effect of options.writes ?? []) set.add(effect);
  return Object.freeze({
    effects: Object.freeze(EFFECT_ORDER.filter((effect) => set.has(effect))),
    reads: Object.freeze([...(options.reads ?? [])]),
    writes: Object.freeze([...(options.writes ?? [])]),
    throws: options.throws === true,
    host: options.host === true,
    transfer: options.transfer === true,
  });
}

const PURE = info({});
const PURE_THROWS = info({ throws: true });
const READ_SCALAR = info({ reads: [Effect.ScalarRead] });
const READ_MEMORY_THROWS = info({ throws: true, reads: [Effect.MemoryRead] });
const READ_BYTES_THROWS = info({
  throws: true,
  reads: [Effect.MemoryRead, Effect.VersionedRead],
});
const WRITE_SCALAR_THROWS = info({ throws: true, writes: [Effect.ScalarWrite] });
const WRITE_MEMORY_THROWS = info({ throws: true, writes: [Effect.MemoryWrite] });
const COPY_THROWS = info({
  throws: true,
  reads: [Effect.MemoryRead, Effect.VersionedRead],
  writes: [Effect.MemoryWrite],
});
/** Host code may read and write anything and re-enter the engine. */
const HOST = info({
  throws: true,
  reads: [Effect.MemoryRead, Effect.ScalarRead, Effect.VersionedRead],
  writes: [Effect.MemoryWrite, Effect.ScalarWrite],
  host: true,
  extra: [Effect.Event, Effect.Output],
});
const HOST_TRANSFER = info({
  throws: true,
  reads: [Effect.MemoryRead, Effect.ScalarRead, Effect.VersionedRead],
  writes: [Effect.MemoryWrite, Effect.ScalarWrite],
  host: true,
  transfer: true,
  extra: [Effect.Event, Effect.Output],
});
/** Synthetic checks may throw; J11 refines this once the check kind is known. */
const CHECK = info({ throws: true });
/**
 * Register spill writeback is not observable storage from the MIR effect
 * model's point of view (it has no results and never throws); DCE keeps it
 * explicitly because it is a real write.
 */
const SPILL = info({});
/** Promoted-location reads come from a local (J12). */
const PROMOTE_LOAD = info({ reads: [Effect.ScalarRead] });
/** Promoted stores can only throw through the suspended slow path (J12). */
const PROMOTE_STORE = info({ throws: true });
/** Barriers reload promoted locals from the backing view (J12). */
const PROMOTE_RELOAD = info({ reads: [Effect.ScalarRead] });
/** The loop-versioning guard is pure and cannot throw (J12). */
const BOUNDS_GUARD = info({});

/** Static effect table. */
export const EFFECT_INFO: Readonly<Record<Op, EffectInfo>> = {
  [Op.Const]: PURE,
  [Op.BoolNot]: PURE,
  [Op.BoolAnd]: PURE,
  [Op.BoolOr]: PURE,
  [Op.BoolXor]: PURE,
  [Op.IntAdd]: PURE,
  [Op.IntSub]: PURE,
  [Op.IntMul]: PURE,
  [Op.IntDiv]: PURE_THROWS,
  [Op.IntRem]: PURE_THROWS,
  [Op.IntAnd]: PURE,
  [Op.IntOr]: PURE,
  [Op.IntXor]: PURE,
  [Op.IntNot]: PURE,
  [Op.IntShl]: PURE,
  [Op.IntLshr]: PURE,
  [Op.IntAshr]: PURE,
  [Op.IntCmp]: PURE,
  [Op.IntZext]: PURE,
  [Op.IntSext]: PURE,
  [Op.IntTrunc]: PURE,
  [Op.IntReinterpret]: PURE,
  [Op.FloatAdd]: PURE,
  [Op.FloatSub]: PURE,
  [Op.FloatMul]: PURE,
  [Op.FloatDiv]: PURE,
  [Op.FloatFma]: PURE,
  [Op.FloatCmp]: PURE,
  [Op.FloatIsNaN]: PURE,
  [Op.FloatIsFinite]: PURE,
  [Op.ConvertIntToFloat]: PURE,
  [Op.ConvertFloatToInt]: PURE_THROWS,
  [Op.ConvertFloat]: PURE,
  [Op.Bitcast]: PURE,
  [Op.Select]: PURE,
  [Op.StateLoad]: READ_SCALAR,
  [Op.StateStore]: WRITE_SCALAR_THROWS,
  [Op.ArrayLoad]: READ_MEMORY_THROWS,
  [Op.ArrayStore]: WRITE_MEMORY_THROWS,
  [Op.BytesLoad]: READ_BYTES_THROWS,
  [Op.BytesStore]: WRITE_MEMORY_THROWS,
  [Op.BytesCopy]: COPY_THROWS,
  [Op.ResourceUpdateBytes]: COPY_THROWS,
  [Op.ResourceFillBytes]: WRITE_MEMORY_THROWS,
  [Op.BridgeSend]: HOST,
  [Op.BridgeSendBytes]: HOST,
  [Op.Call]: HOST,
  [Op.EventNow]: HOST,
  [Op.EventAt]: HOST,
  [Op.EventCancel]: HOST,
  [Op.Checkpoint]: HOST_TRANSFER,
  [Op.Executor]: HOST,
  [Op.Check]: CHECK,
  [Op.Spill]: SPILL,
  [Op.Forward]: PURE,
  [Op.PromoteLoad]: PROMOTE_LOAD,
  [Op.PromoteStore]: PROMOTE_STORE,
  [Op.PromoteReload]: PROMOTE_RELOAD,
  [Op.BoundsGuard]: BOUNDS_GUARD,
};

const ALL_EFFECTS: readonly Effect[] = HOST_TRANSFER.effects;

/** Effects of one instruction; `call` uses the callee summary when it is known. */
export function computeEffects(inst: MInst, callee?: FunctionSummary): readonly Effect[] {
  if (inst.op === Op.Call) return callee?.effects ?? ALL_EFFECTS;
  const description = EFFECT_INFO[inst.op];
  if (description === undefined) {
    throw new Error(`MIR effects failed: unknown opcode "${String(inst.op)}"`);
  }
  return description.effects;
}

/** One result position: `D`/`U` for floats, `bool`/`int` otherwise. */
export type ResultRep = Rep;

/** Whole-function summary shared by the callers and later passes. */
export interface FunctionSummary {
  readonly functionIndex: number;
  readonly effects: readonly Effect[];
  readonly reads: readonly Effect[];
  readonly writes: readonly Effect[];
  readonly throws: boolean;
  readonly host: boolean;
  /** The function (or something it calls) can transfer control to a provider artifact. */
  readonly hasTransfer: boolean;
  /** Part of a non-trivial call-graph SCC or calls itself. */
  readonly recursive: boolean;
  /** Representation of each result, in declaration order. */
  readonly resultReps: readonly ResultRep[];
}

export interface SummaryOptions {
  readonly callees?: ReadonlyMap<number, FunctionSummary>;
}

function emptyResultReps(fn: MFunction, floating: Rep): readonly ResultRep[] {
  return fn.results.map((type) => {
    if (isFloatType(type)) return floating;
    return type === 'bool' ? 'bool' : 'int';
  });
}

/** Optimistic value used while iterating a recursive SCC: every float result is D. */
function optimisticResultReps(fn: MFunction): readonly ResultRep[] {
  return emptyResultReps(fn, 'D');
}

interface OwnEffects {
  readonly effects: Set<Effect>;
  readonly reads: Set<Effect>;
  readonly writes: Set<Effect>;
  host: boolean;
  transfer: boolean;
}

function collectOwnEffects(fn: MFunction): OwnEffects {
  const result: OwnEffects = {
    effects: new Set<Effect>(),
    reads: new Set<Effect>(),
    writes: new Set<Effect>(),
    host: false,
    transfer: false,
  };
  const add = (description: EffectInfo): void => {
    for (const effect of description.effects) result.effects.add(effect);
    for (const effect of description.reads) result.reads.add(effect);
    for (const effect of description.writes) result.writes.add(effect);
    result.host ||= description.host;
    result.transfer ||= description.transfer;
  };
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      // Calls are handled separately by the interprocedural step.
      if (inst.op === Op.Call) continue;
      add(EFFECT_INFO[inst.op]);
    }
    if (block.term.kind === 'dispatch') {
      for (const effect of ALL_EFFECTS) result.effects.add(effect);
      for (const effect of HOST_TRANSFER.reads) result.reads.add(effect);
      for (const effect of HOST_TRANSFER.writes) result.writes.add(effect);
      result.host = true;
      result.transfer = true;
    } else if (block.term.kind === 'trap') {
      result.effects.add(Effect.Throws);
    }
  }
  return result;
}

function ordered(set: ReadonlySet<Effect>): readonly Effect[] {
  return Object.freeze(EFFECT_ORDER.filter((effect) => set.has(effect)));
}

interface MutableEffects {
  readonly effects: Set<Effect>;
  readonly reads: Set<Effect>;
  readonly writes: Set<Effect>;
  host: boolean;
  transfer: boolean;
}

function addSummary(target: MutableEffects, summary: FunctionSummary): void {
  for (const effect of summary.effects) target.effects.add(effect);
  for (const effect of summary.reads) target.reads.add(effect);
  for (const effect of summary.writes) target.writes.add(effect);
  target.host ||= summary.host;
  target.transfer ||= summary.hasTransfer;
}

function summarize(
  fn: MFunction,
  summaries: ReadonlyMap<number, FunctionSummary>,
  resultReps: readonly ResultRep[],
  recursive: boolean,
  propagateCalls: boolean,
): FunctionSummary {
  const own = collectOwnEffects(fn);
  const combined: MutableEffects = {
    effects: new Set(own.effects),
    reads: new Set(own.reads),
    writes: new Set(own.writes),
    host: own.host,
    transfer: own.transfer,
  };
  if (propagateCalls) {
    for (const block of fn.blocks) {
      for (const inst of block.insts) {
        if (inst.op !== Op.Call) continue;
        const callee = summaries.get(inst.refs[0] ?? -1);
        if (callee !== undefined) {
          addSummary(combined, callee);
          continue;
        }
        // Unknown callee: assume the worst so the summary stays sound.
        for (const effect of ALL_EFFECTS) combined.effects.add(effect);
        for (const effect of HOST_TRANSFER.reads) combined.reads.add(effect);
        for (const effect of HOST_TRANSFER.writes) combined.writes.add(effect);
        combined.host = true;
        combined.transfer = true;
      }
    }
  }
  return {
    functionIndex: fn.functionIndex,
    effects: ordered(combined.effects),
    reads: ordered(combined.reads),
    writes: ordered(combined.writes),
    throws: combined.effects.has(Effect.Throws),
    host: combined.host,
    hasTransfer: combined.transfer,
    recursive,
    resultReps,
  };
}

/** Join the representations of every `return` terminator. */
export function returnRepresentations(
  fn: MFunction,
  reps: ReadonlyMap<number, Rep>,
): readonly ResultRep[] {
  let returns = 0;
  const joined: (Rep | undefined)[] = new Array<Rep | undefined>(fn.results.length);
  for (const block of fn.blocks) {
    if (block.term.kind !== 'return') continue;
    returns += 1;
    block.term.values.forEach((value, index) => {
      const rep = reps.get(value);
      const previous = joined[index];
      if (rep !== undefined) {
        joined[index] = previous === undefined ? rep : previous === rep ? rep : 'U';
      }
    });
  }
  return fn.results.map((type, index) => {
    if (!isFloatType(type)) return type === 'bool' ? 'bool' : 'int';
    const rep = joined[index];
    return returns === 0 || rep === undefined ? 'U' : rep;
  });
}

/**
 * Summary of one function. Without `callees`, every unresolved call is treated
 * conservatively (all effects, host, transfer) and float results are `U`.
 */
export function computeFunctionSummary(
  fn: MFunction,
  options: SummaryOptions = {},
): FunctionSummary {
  const callees = options.callees ?? new Map<number, FunctionSummary>();
  const reps = analyzeRepresentation(fn, callees);
  return summarize(fn, callees, returnRepresentations(fn, reps), false, true);
}

/* ------------------------------------------------------------------ */
/* Call-graph SCCs                                                     */
/* ------------------------------------------------------------------ */

function callGraph(fns: readonly MFunction[]): Map<number, readonly number[]> {
  const known = new Set(fns.map((fn) => fn.functionIndex));
  const edges = new Map<number, readonly number[]>();
  for (const fn of fns) {
    const targets = new Set<number>();
    for (const block of fn.blocks) {
      for (const inst of block.insts) {
        if (inst.op !== Op.Call) continue;
        const target = inst.refs[0];
        if (target !== undefined && known.has(target)) targets.add(target);
      }
    }
    edges.set(fn.functionIndex, [...targets]);
  }
  return edges;
}

/**
 * Tarjan's algorithm over the call graph, iterative to keep deep call chains
 * off the JS stack. SCCs are emitted callees-first (reverse topological order).
 */
function stronglyConnected(edges: Map<number, readonly number[]>): number[][] {
  const indices = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const components: number[][] = [];
  let next = 0;

  for (const root of edges.keys()) {
    if (indices.has(root)) continue;
    const work: { readonly v: number; i: number }[] = [{ v: root, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i === 0) {
        indices.set(frame.v, next);
        low.set(frame.v, next);
        next += 1;
        stack.push(frame.v);
        onStack.add(frame.v);
      }
      const successors = edges.get(frame.v) ?? [];
      if (frame.i < successors.length) {
        const w = successors[frame.i]!;
        frame.i += 1;
        if (!indices.has(w)) {
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, indices.get(w)!));
        }
        continue;
      }
      work.pop();
      if (low.get(frame.v) === indices.get(frame.v)) {
        const component: number[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.v) break;
        }
        components.push(component);
      }
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
      }
    }
  }
  return components;
}

/* ------------------------------------------------------------------ */
/* Interprocedural summaries                                           */
/* ------------------------------------------------------------------ */

function sameReps(a: readonly ResultRep[], b: readonly ResultRep[]): boolean {
  return a.length === b.length && a.every((rep, index) => rep === b[index]);
}

function sameSummary(a: FunctionSummary, b: FunctionSummary): boolean {
  const sameEffects =
    a.effects.length === b.effects.length &&
    a.effects.every((effect, index) => effect === b.effects[index]);
  return (
    sameEffects &&
    a.throws === b.throws &&
    a.host === b.host &&
    a.hasTransfer === b.hasTransfer &&
    a.recursive === b.recursive &&
    sameReps(a.resultReps, b.resultReps)
  );
}

/**
 * Compute summaries for every supplied function.
 *
 * SCCs are processed callees-first. Inside one SCC, effects grow monotonically
 * from an empty seed while result representations start optimistically at `D`,
 * so recursive functions reach a fixed point in at most a handful of passes.
 */
export function computeSummaries(functions: readonly MFunction[]): Map<number, FunctionSummary> {
  const byIndex = new Map<number, MFunction>();
  for (const fn of functions) {
    if (byIndex.has(fn.functionIndex)) {
      throw new Error(
        `MIR summary failed: function index ${fn.functionIndex} is declared more than once`,
      );
    }
    byIndex.set(fn.functionIndex, fn);
  }
  const edges = callGraph(functions);
  const components = stronglyConnected(edges);
  const summaries = new Map<number, FunctionSummary>();

  for (const component of components) {
    const recursive =
      component.length > 1 || component.some((index) => (edges.get(index) ?? []).includes(index));
    // Optimistic seed: own effects only, every float result assumed D.
    for (const index of component) {
      const fn = byIndex.get(index)!;
      summaries.set(index, summarize(fn, summaries, optimisticResultReps(fn), recursive, false));
    }
    let changed = true;
    let rounds = 0;
    while (changed) {
      changed = false;
      rounds += 1;
      if (rounds > functions.length * 4 + 8) {
        throw new Error('MIR summary failed: fixed point did not converge');
      }
      for (const index of component) {
        const fn = byIndex.get(index)!;
        const reps = analyzeRepresentation(fn, summaries);
        const next = summarize(fn, summaries, returnRepresentations(fn, reps), recursive, true);
        if (!sameSummary(summaries.get(index)!, next)) {
          summaries.set(index, next);
          changed = true;
        }
      }
    }
  }
  return summaries;
}
