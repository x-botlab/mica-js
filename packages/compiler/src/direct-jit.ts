import type {
  BinaryOperator,
  DeclarationIR,
  MatchPatternIR,
  MemoryRefIR,
  OperationIR,
  RegionIR,
  UnaryOperator,
  ValueRegionIR,
} from '@mica-js/device-model';
import type {
  DirectJitBinding,
  DirectJitCache,
  DirectJitCacheStats,
  DirectJitDelay,
  DirectJitFrame,
  DirectJitInstruction,
  DirectJitProgram,
  DirectJitReason,
  DirectJitRunResult,
  DirectJitSession,
  DirectJitSessionStats,
  DirectJitShareCandidate,
  DirectJitShareRejectedStats,
} from './types.js';
import { analyzeBody, type Primitive } from './analysis.js';
import {
  checkBoolean,
  checkDuration,
  checkPc,
  combineIntents,
  createBytes,
  equalValues,
  nonNull,
  readIndex,
} from './values.js';

const binary: Partial<Record<BinaryOperator, string>> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  remainder: '%',
  power: '**',
  lessThan: '<',
  lessThanOrEqual: '<=',
  greaterThan: '>',
  greaterThanOrEqual: '>=',
  equal: '===',
  notEqual: '!==',
  bitAnd: '&',
  bitOr: '|',
  bitXor: '^',
  shiftLeft: '<<',
  shiftRight: '>>',
  shiftRightUnsigned: '>>>',
};
const unary: Partial<Record<UnaryOperator, string>> = {
  positive: '+',
  negate: '-',
  not: '!',
  bitNot: '~',
};
const comparisons = new Set<BinaryOperator>([
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'equal',
  'notEqual',
]);
const numeric = new Set([
  'isNaN',
  'isFinite',
  'isInteger',
  'isSafeInteger',
  'abs',
  'floor',
  'ceil',
  'trunc',
  'round',
  'sqrt',
  'min',
  'max',
  'pow',
]);
const predicates = new Set(['isNaN', 'isFinite', 'isInteger', 'isSafeInteger']);
/** Operations whose results may stay outside the scalar number/bool slot set. */
const wideResults = new Set([
  'field',
  'optional',
  'nonNull',
  'readSample',
  'resistor',
  'combineIntents',
  'bytes',
  // A string result is only produced by indexing a string, which stays a plain slot value.
  'index',
  // A wide select keeps its branches in one slot and never enters the state bank, so a
  // pin-intent choice such as `select(level, [resistor(...)], [])` stays direct.
  'select',
  'match',
]);
/**
 * Result types whose runtime value is an object, so `===` is not the host's value equality.
 * Bytes compare element by element in `equalValues`, and intents compare by branch content.
 */
const referenceResults = new Set(['bytes', 'record', 'sample', 'intent', 'optional']);
/** Operations admitted only when the runtime supplied a direct host for the frame. */
const hosted = new Set([
  'send',
  'notify',
  'readSample',
  'writeIntent',
  'resistor',
  'random',
  'assert',
]);

function offset(memory: Uint8Array, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('offset must be a safe integer');
  if (value < 0) throw new RangeError('offset must be nonnegative');
  if (value >= memory.length) throw new RangeError('Memory range is out of bounds');
  return value;
}

function byte(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('stored value must be a safe integer');
  return value;
}

const views = new WeakMap<Uint8Array, DataView>();

/** One cached wrapper per bank; wide accesses never assemble bytes or allocate per operation. */
function view(memory: Uint8Array): DataView {
  let cached = views.get(memory);
  if (cached === undefined) {
    cached = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    views.set(memory, cached);
  }
  return cached;
}

/** Address check order matches the generic host: safe integer, nonnegative, whole range. */
function address(memory: Uint8Array, value: unknown, size: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('offset must be a safe integer');
  if (value < 0) throw new RangeError('offset must be nonnegative');
  if (value > memory.length || size > memory.length - value)
    throw new RangeError('Memory range is out of bounds');
  return value;
}

function dataView(memory: Uint8Array, cached: DataView | undefined): DataView {
  return cached ?? view(memory);
}

function load16(
  memory: Uint8Array,
  cached: DataView | undefined,
  value: unknown,
  little: boolean,
): number {
  return dataView(memory, cached).getUint16(address(memory, value, 2), little);
}

function load32(
  memory: Uint8Array,
  cached: DataView | undefined,
  value: unknown,
  little: boolean,
): number {
  return dataView(memory, cached).getUint32(address(memory, value, 4), little);
}

function store16(
  memory: Uint8Array,
  cached: DataView | undefined,
  value: unknown,
  stored: unknown,
  little: boolean,
): void {
  const at = address(memory, value, 2);
  dataView(memory, cached).setUint16(at, byte(stored), little);
}

function store32(
  memory: Uint8Array,
  cached: DataView | undefined,
  value: unknown,
  stored: unknown,
  little: boolean,
): void {
  const at = address(memory, value, 4);
  dataView(memory, cached).setUint32(at, byte(stored), little);
}

const helpers = Object.freeze({
  checkBoolean,
  checkDuration,
  checkPc,
  combineIntents,
  createBytes,
  equalValues,
  nonNull,
  readIndex,
  offset,
  byte,
  load16,
  load32,
  store16,
  store32,
});
const unsupported = Symbol('unsupported direct instruction');
/**
 * Compile-time values the reference analyzer proved for one body. Folding is shared rather
 * than reimplemented: `analyzeBody` runs the exact arithmetic `compileBody` emits, so both
 * backends agree on every operator, including `-0`, `NaN`, `%` and the shifts.
 */
const analyses = new WeakMap<RegionIR, ReadonlyMap<number, Primitive>>();

function constantsOf(body: RegionIR): ReadonlyMap<number, Primitive> {
  let constants = analyses.get(body);
  if (constants === undefined) {
    try {
      constants = analyzeBody(body, {}, false).constants;
    } catch {
      // Analysis is an optimisation only: an unexpected shape keeps every value dynamic.
      constants = new Map();
    }
    analyses.set(body, constants);
  }
  return constants;
}

interface BodyShape {
  readonly operations: number;
  readonly nestedOperations: number;
}

/**
 * Operation counts depend only on the immutable body, so a later cache (a new board reusing
 * the module-level block IR) reuses them instead of walking every nested region again.
 */
const shapes = new WeakMap<RegionIR, BodyShape>();

function shapeOf(body: RegionIR): BodyShape {
  let shape = shapes.get(body);
  if (shape === undefined) {
    shape = Object.freeze({
      operations: body.operations.length,
      nestedOperations: countOperations(body),
    });
    shapes.set(body, shape);
  }
  return shape;
}

interface DelayFingerprint {
  readonly counter: number;
  readonly cycles: number;
  readonly pending?: {
    readonly state: number;
    readonly period: number;
    readonly active: number;
  };
}

/** Validated physical identity of a share candidate. */
interface ShareKey {
  readonly storage: string;
  readonly codeVersion: number;
  readonly offset: number;
  readonly byteLength: number;
}

interface ShareStamp {
  readonly share: ShareKey | undefined;
  readonly invalid: boolean;
}

interface BindingFingerprint {
  readonly states: readonly (readonly [string, number])[];
  readonly memories: readonly (readonly [string, number])[];
  readonly pins: readonly (readonly [string, number])[] | undefined;
  readonly pcName: string;
  readonly pcIndex: number;
  readonly host: boolean;
  readonly blockedStates: readonly string[] | undefined;
  readonly blockedMemories: readonly string[] | undefined;
  readonly entryBlockedStates: readonly string[] | undefined;
  readonly entryBlockedMemories: readonly string[] | undefined;
  readonly functions: readonly (readonly [string, DirectFunctionIR])[] | undefined;
}

type DirectFunctionIR = Extract<DeclarationIR, { kind: 'function' }>;
type ResolveFunction = (name: string) => {
  readonly target: string;
  readonly run: unknown;
  readonly body: Instruction;
};

interface CachedInstruction {
  readonly body: RegionIR;
  readonly nextPc: number;
  readonly delay: DelayFingerprint | undefined;
  readonly instruction: Instruction | undefined;
  /** Stable continuation ID once this body has ever emitted an elapse. */
  readonly resumeId: number | undefined;
  /** Explicit physical identity, or undefined when the entry never opted into sharing. */
  readonly share: ShareKey | undefined;
  readonly shareInvalid: boolean;
}

type ResidentStatus = DirectJitReason | number;
type ResidentStep = (frame: DirectJitFrame, deadline: number, pc: number) => ResidentStatus;
type SharedStep = (frame: DirectJitFrame, deadline: number, nextPc: number) => ResidentStatus;
type ResidentResume = (frame: DirectJitFrame, resume: number) => ResidentStatus;

interface ResidentFunctions {
  readonly step: ResidentStep;
  readonly resume: ResidentResume | undefined;
}

interface SharedFunctions {
  readonly step: SharedStep;
  readonly resume: ResidentResume | undefined;
}

/** One step/resume pair reused by every equivalent route of a physical identity. */
interface SharedVariant {
  readonly id: number;
  readonly key: string;
  readonly share: ShareKey;
  readonly delay: DelayFingerprint | undefined;
  /** The validated body every route in this variant must match structurally. */
  readonly body: RegionIR;
  /** Representative compiled body; its emitted IR is shared by the whole variant. */
  readonly instruction: Instruction;
  functions: SharedFunctions | undefined;
  /** Continuation identifier owned by the shared function, never by an independent body. */
  resumeId: number;
  sourceSize: number;
  /** Current logical PC → route nextPc. */
  entries: Map<number, number>;
  /** PCs already attributed to this shared body for `shareReusedBodies`. */
  attributed: Set<number>;
}

interface SharedRoute {
  readonly step: SharedStep;
  readonly nextPc: number;
  readonly variant: SharedVariant;
}

type SessionRoute = ResidentStep | SharedRoute;

function isSharedRoute(route: SessionRoute | undefined): route is SharedRoute {
  return route !== undefined && typeof route !== 'function';
}

function sameSessionRoute(current: SessionRoute | undefined, desired: SessionRoute): boolean {
  if (current === desired) return true;
  if (current === undefined || typeof current === 'function') return false;
  if (typeof desired === 'function') return false;
  return current.step === desired.step && current.nextPc === desired.nextPc;
}

interface ShareCandidateEntry {
  readonly pc: number;
  readonly nextPc: number;
  readonly record: CachedInstruction;
  readonly instruction: Instruction;
  readonly share: ShareKey;
}

type ShareCategory =
  'shared' | 'missing' | 'invalid' | 'single' | 'ir' | 'delay' | 'isolated' | 'context';

interface ResidentShard {
  readonly id: number;
  entries: Instruction[];
  sourceSize: number;
  maxSlots: number;
  resumable: boolean;
  functions: ResidentFunctions | undefined;
  /** Exact instruction sequence represented by `functions`; cache hits compare references. */
  signature: readonly Instruction[] | undefined;
  dirty: boolean;
}

interface DirectJitCacheState {
  readonly entries: Map<number, CachedInstruction>;
  readonly constants: unknown[];
  readonly resistorSlots: Map<string, number>;
  readonly functions: Map<string, ReturnType<ResolveFunction> | null>;
  readonly shards: ResidentShard[];
  nextResume: number;
  nextShard: number;
  /** Cumulative source characters of separately emitted synchronous helpers. */
  helperBytes: number;
  stats: {
    compiledBlocks: number;
    reusedBlocks: number;
    invalidatedBlocks: number;
    compiledShards: number;
    reusedShards: number;
    clears: number;
  };
  binding: BindingFingerprint | undefined;
}

const directJitCaches = new WeakMap<DirectJitCache, DirectJitCacheState>();
/** At most one live incremental session owns a cache's mutable shard set. */
const directJitSessions = new WeakMap<DirectJitCache, DirectJitSessionImpl>();

function createDirectJitCache(): DirectJitCache {
  const cache = Object.freeze({}) as unknown as DirectJitCache;
  directJitCaches.set(cache, {
    entries: new Map(),
    constants: [],
    resistorSlots: new Map(),
    functions: new Map(),
    shards: [],
    nextResume: 1,
    nextShard: 1,
    helperBytes: 0,
    stats: {
      compiledBlocks: 0,
      reusedBlocks: 0,
      invalidatedBlocks: 0,
      compiledShards: 0,
      reusedShards: 0,
      clears: 0,
    },
    binding: undefined,
  });
  return cache;
}

function cacheState(cache: DirectJitCache): DirectJitCacheState {
  const state = directJitCaches.get(cache);
  if (state === undefined) throw new TypeError('Invalid direct JIT cache');
  return state;
}

function bindingFingerprint(binding: DirectJitBinding): BindingFingerprint {
  return {
    states: [...binding.states],
    memories: [...binding.memories],
    pins: binding.pins === undefined ? undefined : [...binding.pins],
    pcName: binding.pc.name,
    pcIndex: binding.pc.index,
    host: binding.host === true,
    functions: binding.functions === undefined ? undefined : [...binding.functions],
    blockedStates:
      binding.blockedStates === undefined ? undefined : [...binding.blockedStates].sort(),
    blockedMemories:
      binding.blockedMemories === undefined ? undefined : [...binding.blockedMemories].sort(),
    entryBlockedStates:
      binding.entryBlockedStates === undefined ? undefined : [...binding.entryBlockedStates].sort(),
    entryBlockedMemories:
      binding.entryBlockedMemories === undefined
        ? undefined
        : [...binding.entryBlockedMemories].sort(),
  };
}

function samePairs<T>(
  left: readonly (readonly [string, T])[],
  right: readonly (readonly [string, T])[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a[0] !== b[0] || a[1] !== b[1]) return false;
  }
  return true;
}

function sameOptionalPairs<T>(
  left: readonly (readonly [string, T])[] | undefined,
  right: readonly (readonly [string, T])[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return samePairs(left, right);
}

function sameNames(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

function sameBinding(left: BindingFingerprint, right: BindingFingerprint): boolean {
  return (
    left.pcName === right.pcName &&
    left.pcIndex === right.pcIndex &&
    left.host === right.host &&
    sameOptionalPairs(left.functions, right.functions) &&
    samePairs(left.states, right.states) &&
    samePairs(left.memories, right.memories) &&
    sameOptionalPairs(left.pins, right.pins) &&
    sameNames(left.blockedStates, right.blockedStates) &&
    sameNames(left.blockedMemories, right.blockedMemories) &&
    sameNames(left.entryBlockedStates, right.entryBlockedStates) &&
    sameNames(left.entryBlockedMemories, right.entryBlockedMemories)
  );
}

function delayFingerprint(delay: DirectJitDelay | undefined): DelayFingerprint | undefined {
  if (delay === undefined) return undefined;
  return {
    counter: delay.counter,
    cycles: delay.cycles,
    ...(delay.pending === undefined ? {} : { pending: { ...delay.pending } }),
  };
}

function sameDelay(
  left: DelayFingerprint | undefined,
  right: DelayFingerprint | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.counter === right.counter &&
    left.cycles === right.cycles &&
    left.pending?.state === right.pending?.state &&
    left.pending?.period === right.pending?.period &&
    left.pending?.active === right.pending?.active
  );
}

/**
 * Structural equality of validated IR. Object.is keeps `-0`, `NaN`, `Infinity` and boolean
 * identity exact; array order is execution order, and source positions compare as data.
 * The checked pair set only defends against an unexpected cyclic object graph: validation
 * treats the input as immutable, so an equal DAG remains equal without memoisation.
 */
function sameRegion(left: RegionIR, right: RegionIR): boolean {
  return sameIrValue(left, right, new WeakMap());
}

function sameIrValue(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>>,
): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false;
  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  if (leftArray !== rightArray) return false;
  if (leftArray && (left as readonly unknown[]).length !== (right as readonly unknown[]).length)
    return false;
  let pairs = seen.get(left);
  if (pairs?.has(right)) return true;
  if (pairs === undefined) {
    pairs = new WeakSet();
    seen.set(left, pairs);
  }
  pairs.add(right);
  if (leftArray) {
    const a = left as readonly unknown[];
    const b = right as readonly unknown[];
    for (let index = 0; index < a.length; index++)
      if (!sameIrValue(a[index], b[index], seen)) return false;
    return true;
  }
  const a = left as Readonly<Record<string, unknown>>;
  const b = right as Readonly<Record<string, unknown>>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] === undefined && b[key] === undefined) continue;
    if (!sameIrValue(a[key], b[key], seen)) return false;
  }
  return true;
}

function shareKeyText(share: ShareKey): string {
  return JSON.stringify([share.storage, share.codeVersion, share.offset, share.byteLength]);
}

/** Validate the explicit marker. An invalid marker still lets the entry run independently. */
function readShare(candidate: DirectJitShareCandidate | undefined): ShareStamp {
  if (candidate === undefined) return { share: undefined, invalid: false };
  if (typeof candidate !== 'object' || candidate === null)
    return { share: undefined, invalid: true };
  const { storage, codeVersion, offset, byteLength } = candidate;
  if (
    typeof storage !== 'string' ||
    storage.length === 0 ||
    !Number.isSafeInteger(codeVersion) ||
    codeVersion < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    !Number.isSafeInteger(offset + byteLength)
  )
    return { share: undefined, invalid: true };
  return {
    share: { storage, codeVersion, offset, byteLength },
    invalid: false,
  };
}

function sameShare(left: ShareKey | undefined, right: ShareKey | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.storage === right.storage &&
      left.codeVersion === right.codeVersion &&
      left.offset === right.offset &&
      left.byteLength === right.byteLength)
  );
}

function clearCacheState(state: DirectJitCacheState): void {
  state.entries.clear();
  state.constants.length = 0;
  state.resistorSlots.clear();
  state.functions.clear();
  state.shards.length = 0;
  state.nextResume = 1;
  state.nextShard = 1;
  state.binding = undefined;
  state.stats.clears++;
}

export interface DirectJitCompiler {
  (
    instructions: readonly {
      readonly pc: number;
      readonly nextPc: number;
      readonly body: RegionIR;
    }[],
    binding: DirectJitBinding,
    cache?: DirectJitCache,
  ): DirectJitProgram | undefined;
  createCache(): DirectJitCache;
  /** Create or replace the single incremental session attached to a cache. */
  createSession(binding: DirectJitBinding, cache?: DirectJitCache): DirectJitSession;
  clearCache(cache: DirectJitCache): void;
  cacheStats(cache: DirectJitCache): DirectJitCacheStats;
}

/** One compile-time value and the literal source text that reproduces it exactly. */
interface Folded {
  readonly value: Primitive;
  readonly text: string;
}

/** Development-only code shape: how many host statements one IR operation costs. */
export interface DirectJitEmitStats {
  readonly blocks: number;
  /** Top-level IR operations, the denominator #256 quotes for one instruction block. */
  readonly operations: number;
  /** IR operations including nested value and statement regions. */
  readonly nestedOperations: number;
  readonly statements: number;
  readonly statementsPerOperation: number;
  readonly statementsPerNestedOperation: number;
  /** Operations that cost no statement because they folded; adds back the pre-folding count. */
  readonly foldedOperations: number;
  readonly selectBlocks: number;
  /** Worst block by statements per operation; `null` for an empty program. */
  readonly worst: {
    readonly pc: number;
    readonly operations: number;
    readonly statements: number;
    readonly statementsPerOperation: number;
    readonly foldedOperations: number;
    readonly selectBlocks: number;
  } | null;
}

/**
 * Code budget for one generated shard. Emitted characters, not registers, predict where V8
 * stops optimizing a function: measured blocks slow down sharply from ~35 KB of source.
 */
const SHARD_CODE_BUDGET = 36_000;
/** Default instruction count per resident shard; `DirectJitBinding.shardSize` overrides it. */
const DIRECT_SHARD_SIZE = 48;
// Only outline a large, asymmetric branch: the extra call and slot copy should not
// be paid by both arms of a common conditional.
const OUTLINE_MIN_LINES = 512;
const OUTLINE_MIN_RATIO = 8;
const OUTLINE_MAX_SLOTS = 64;
/**
 * Below this summed source size the monolithic form stays inside the range V8 optimizes, and
 * it avoids the dispatcher hop; larger programs split into shards.
 */
const MONOLITH_CODE_LIMIT = 48_000;
/** Above this many routes, a linear chain spends more time comparing bounds than dispatching. */
const SHARD_ROUTE_TREE_MIN = 16;

interface ShardRoute {
  readonly bound: string;
  readonly call: string;
}

/**
 * Emit a balanced search tree over ordered range bounds. Leaves stay direct calls to named
 * shard functions so the call sites remain monomorphic; the extra miss leaf preserves exactly
 * the old fallback / unknown-continuation behaviour.
 */
function emitShardRoutes(
  lines: string[],
  key: 'pc' | 'resume',
  routes: readonly ShardRoute[],
  miss: string,
): void {
  if (routes.length < SHARD_ROUTE_TREE_MIN) {
    routes.forEach((route, index) => {
      lines.push(`${index ? 'else if' : 'if'} (${key} <= ${route.bound}) ${route.call}`);
    });
    lines.push(`else ${miss}`);
    return;
  }
  const actions = [...routes.map((route) => route.call), miss];
  const emit = (lower: number, upper: number): void => {
    if (lower === upper) {
      lines.push(actions[lower]!);
      return;
    }
    const middle = (lower + upper) >>> 1;
    lines.push(`if (${key} <= ${routes[middle]!.bound}) {`);
    emit(lower, middle);
    lines.push('} else {');
    emit(middle + 1, upper);
    lines.push('}');
  };
  emit(0, routes.length);
}

/** Inputs have already passed model validation and contextual binding. */
function compileDirectJitProgram(
  instructions: readonly {
    readonly pc: number;
    readonly nextPc: number;
    readonly body: RegionIR;
  }[],
  binding: DirectJitBinding,
  suppliedCache?: DirectJitCache,
): DirectJitProgram | undefined {
  if (!validIndex(binding.pc.index) || binding.states.get(binding.pc.name) !== binding.pc.index)
    return undefined;
  const cache = suppliedCache ?? createDirectJitCache();
  // A full-program build owns and reorders the same shard set, so an incremental session
  // must stop dispatching before the cache is reconciled.
  directJitSessions.get(cache)?.dispose();
  const state = cacheState(cache);
  const fingerprint = bindingFingerprint(binding);
  if (state.binding !== undefined && !sameBinding(state.binding, fingerprint)) {
    // Slot indices are embedded in every emitted body. A layout change invalidates all of
    // them, but old programs retain their own frozen constant table and stay self-contained.
    state.stats.invalidatedBlocks += state.entries.size;
    state.entries.clear();
    state.constants.length = 0;
    state.resistorSlots.clear();
    state.functions.clear();
    state.shards.length = 0;
    state.nextResume = 1;
    state.nextShard = 1;
  }
  state.binding = fingerprint;
  const capture = (value: unknown): string => `C[${state.constants.push(value) - 1}]`;
  const resistorSlot = (pin: string, resistance: number): number => {
    const key = `${pin}\0${resistance}`;
    let slot = state.resistorSlots.get(key);
    if (slot === undefined) {
      slot = state.resistorSlots.size;
      state.resistorSlots.set(key, slot);
    }
    return slot;
  };
  const resolveFunction: ResolveFunction = (name) => {
    const cached = state.functions.get(name);
    if (cached === null) throw unsupported;
    if (cached !== undefined) return cached;
    // A rejected or cyclic callee rejects its caller before any instruction executes.
    state.functions.set(name, null);
    const fn = binding.functions?.get(name);
    if (fn === undefined) throw unsupported;
    const constants: unknown[] = [];
    const captureLocal = (value: unknown): string => `C[${constants.push(value) - 1}]`;
    const body = new Instruction(
      binding,
      captureLocal,
      resistorSlot,
      (callee) => {
        const nested = resolveFunction(callee);
        return { ...nested, target: captureLocal(nested.run) };
      },
      fn,
    );
    const run = body.compileFunction(constants);
    state.helperBytes += body.functionSourceSize;
    const compiled = { target: capture(run), run, body };
    state.functions.set(name, compiled);
    return compiled;
  };
  const entries: Instruction[] = [];
  const active = new Map<number, Instruction>();
  const seen = new Set<number>();
  for (const instruction of instructions) {
    if (!Number.isFinite(instruction.pc) || seen.has(instruction.pc)) continue;
    // Even an unsupported first occurrence owns this PC, matching runtime lookup.
    seen.add(instruction.pc);
    if (!Number.isFinite(instruction.nextPc)) {
      if (state.entries.delete(instruction.pc)) state.stats.invalidatedBlocks++;
      continue;
    }
    const delay = delayFingerprint(binding.delayLoops?.get(instruction.pc));
    const cached = state.entries.get(instruction.pc);
    let compiled: Instruction | undefined;
    let resumeId = cached?.resumeId;
    if (
      cached !== undefined &&
      cached.body === instruction.body &&
      cached.nextPc === instruction.nextPc &&
      sameDelay(cached.delay, delay)
    ) {
      compiled = cached.instruction;
      if (compiled !== undefined) compiled.resumeId = resumeId ?? 0;
      // A full build has no share markers: keep cached bodies but drop stale sharing metadata
      // so a later session cannot route them through a shared body that this build never used.
      if (cached.share !== undefined || cached.shareInvalid)
        state.entries.set(instruction.pc, { ...cached, share: undefined, shareInvalid: false });
      state.stats.reusedBlocks++;
    } else {
      if (cached !== undefined) state.stats.invalidatedBlocks++;
      try {
        compiled = new Instruction(binding, capture, resistorSlot, resolveFunction).compile(
          instruction,
        );
      } catch (error) {
        if (error !== unsupported) throw error;
        compiled = undefined;
      }
      if (compiled?.duration !== undefined && resumeId === undefined) resumeId = state.nextResume++;
      if (compiled !== undefined) compiled.resumeId = resumeId ?? 0;
      state.entries.set(instruction.pc, {
        body: instruction.body,
        nextPc: instruction.nextPc,
        delay,
        instruction: compiled,
        resumeId,
        share: undefined,
        shareInvalid: false,
      });
      state.stats.compiledBlocks++;
    }
    if (compiled !== undefined) {
      entries.push(compiled);
      active.set(compiled.pcValue, compiled);
    }
  }
  if (!entries.length) return undefined;
  let localCount = 0;
  for (const entry of entries) if (entry.slots.length > localCount) localCount = entry.slots.length;
  const registers = Array.from({ length: localCount }, (_, index) => `v${index}`);
  const options = binding as DirectJitBinding & {
    readonly split?: boolean;
    readonly shardSize?: number;
    readonly shardSlotLimit?: number;
  };
  const shardSize =
    validIndex(options.shardSize) && options.shardSize > 0 ? options.shardSize : DIRECT_SHARD_SIZE;
  // A supplied cache makes the split form resident: instruction bodies and shard functions stay
  // alive while each build only assembles a fresh dispatcher over the current shard set.
  if (options.split === true && suppliedCache !== undefined)
    return residentProgram(state, entries, binding, shardSize);
  // An explicit slot limit keeps the historical slot-based switch; otherwise the emitted
  // source size decides, because register reuse makes slot counts wildly optimistic.
  const slotLimit = validIndex(options.shardSlotLimit) ? options.shardSlotLimit : undefined;
  const split =
    options.split === true &&
    (slotLimit === undefined
      ? entries.reduce((sum, entry) => sum + entry.size, 0) > MONOLITH_CODE_LIMIT
      : entries.reduce((sum, entry) => sum + entry.slots.length, 0) > slotLimit);
  const lines = split
    ? shardProgram(entries, binding, shardSize)
    : monolithicProgram(entries, binding, registers);
  // Only compiler templates/indices and compiler-validated primitive number, boolean and
  // JSON-encoded string literals enter source; every other IR value stays closure data in C.
  const factory = new Function(
    'C',
    'H',
    split
      ? `"use strict";\n${lines.join('\n')}\nreturn run;`
      : `"use strict"; return (${lines.join('\n')});`,
  ) as (
    constants: readonly unknown[],
    runtimeHelpers: typeof helpers,
  ) => (frame: DirectJitFrame, deadline: number) => DirectJitReason;
  const shardCount = lines.filter((line) => line.startsWith('function stepShard')).length;
  const program = {
    // Indices captured by cached instructions remain stable for this cache. The program owns
    // a frozen snapshot so later incremental builds can keep appending without mutating it.
    run: factory(Object.freeze([...state.constants]), helpers),
    shards: split ? shardCount : 1,
    // Every PC this program can dispatch. The runtime keeps executing an older program
    // while it still contains the current PC: translation only ever adds cache entries, so
    // existing bodies never change and only the missing PCs justify a rebuild.
    pcs: Object.freeze(entries.map((entry) => entry.pcValue)),
    localCount,
    readStates: resourceNames(entries, 'readStates'),
    writeStates: resourceNames(entries, 'writeStates'),
    readMemories: resourceNames(entries, 'readMemories'),
    writeMemories: resourceNames(entries, 'writeMemories'),
  } satisfies DirectJitProgram;
  // Diagnostic only, and non-enumerable so the published shape of a program is unchanged.
  Object.defineProperty(program, 'emitStats', { value: emitStats(entries) });
  return Object.freeze(program);
}

export const compileDirectJit: DirectJitCompiler = Object.assign(compileDirectJitProgram, {
  createCache: createDirectJitCache,
  createSession(binding: DirectJitBinding, cache?: DirectJitCache): DirectJitSession {
    return createDirectJitSession(binding, cache);
  },
  clearCache(cache: DirectJitCache): void {
    directJitSessions.get(cache)?.dispose();
    clearCacheState(cacheState(cache));
  },
  cacheStats(cache: DirectJitCache): DirectJitCacheStats {
    const state = cacheState(cache);
    return Object.freeze({ ...state.stats, entries: state.entries.size });
  },
});

/**
 * Statements per IR operation, the acceptance metric of #256. `statements` counts the
 * semicolons of the emitted instruction body (write barrier, busy-wait fold, prefix and
 * suffix); the fixed per-instruction bookkeeping the dispatcher emits (PC write, dirty word,
 * continuation return) is excluded, because it does not depend on the body's shape.
 */
function emitStats(entries: readonly Instruction[]): DirectJitEmitStats {
  let operations = 0;
  let nested = 0;
  let total = 0;
  let folded = 0;
  let selectBlocks = 0;
  let worst: DirectJitEmitStats['worst'] = null;
  const round = (value: number): number => Number(value.toFixed(3));
  for (const entry of entries) {
    operations += entry.operations;
    nested += entry.nestedOperations;
    total += entry.statements;
    folded += entry.foldedOperations;
    selectBlocks += entry.selects;
    const ratio = entry.operations ? entry.statements / entry.operations : 0;
    if (worst === null || ratio > worst.statementsPerOperation)
      worst = Object.freeze({
        pc: entry.pcValue,
        operations: entry.operations,
        statements: entry.statements,
        statementsPerOperation: round(ratio),
        foldedOperations: entry.foldedOperations,
        selectBlocks: entry.selects,
      });
  }
  return Object.freeze({
    blocks: entries.length,
    operations,
    nestedOperations: nested,
    statements: total,
    statementsPerOperation: round(operations ? total / operations : 0),
    statementsPerNestedOperation: round(nested ? total / nested : 0),
    foldedOperations: folded,
    selectBlocks,
    worst,
  });
}

/** Every IR operation the emitter walks, nested value and statement regions included. */
function countOperations(region: RegionIR): number {
  let total = 0;
  for (const operation of region.operations) {
    total++;
    switch (operation.kind) {
      case 'if':
        total += countOperations(operation.yes);
        if (operation.no) total += countOperations(operation.no);
        break;
      case 'match':
        for (const arm of operation.arms) total += countOperations(arm.body);
        if (operation.otherwise) total += countOperations(operation.otherwise);
        break;
      case 'select':
        total += countOperations(operation.yes.body) + countOperations(operation.no.body);
        break;
      case 'and':
      case 'or':
        total += countOperations(operation.right.body);
        break;
      case 'while':
        total += countOperations(operation.test.body) + countOperations(operation.body);
        break;
      case 'assert':
        if (operation.message) total += countOperations(operation.message.body);
        break;
      default:
        break;
    }
  }
  return total;
}

/** Semicolons outside string literals: one per emitted statement (no line holds two). */
function countStatements(line: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '\\') index++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ';') count++;
  }
  return count;
}

/** ASCII digits and the JavaScript `\w` set: the boundaries of an emitted `v<slot>` token. */
function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isWordCode(code: number): boolean {
  return (
    isAsciiDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
  );
}

/** Skip a JSON-encoded literal; its contents are data, including text such as `v0`. */
function afterString(line: string, start: number): number {
  let index = start + 1;
  while (index < line.length) {
    const code = line.charCodeAt(index++);
    if (code === 92) index++;
    else if (code === 34) break;
  }
  return index;
}

/** `select<digits>: {` is the only emitted statement shape counted as a select block. */
function isSelectLabel(line: string): boolean {
  if (!line.startsWith('select')) return false;
  let index = 'select'.length;
  const digits = index;
  while (index < line.length) {
    if (!isAsciiDigit(line.charCodeAt(index))) break;
    index++;
  }
  return index > digits && line.startsWith(': {', index);
}

/** Union of one resource field across blocks; insertion order matches Set construction. */
function resourceNames(
  entries: readonly Instruction[],
  field: 'readStates' | 'writeStates' | 'readMemories' | 'writeMemories',
): readonly string[] {
  const names = new Set<string>();
  for (const entry of entries) for (const name of entry[field]) names.add(name);
  return Object.freeze([...names]);
}

/**
 * `BS` / `BM` are the runtime write barriers: word masks of the state and memory slots the
 * simulator currently observes. They stay outside `DirectJitFrame` because the runtime
 * mutates them in place, so one compiled program stays valid across observer changes. A frame
 * built without them (compiler tests) yields an empty mask and never blocks.
 */
const prelude = (slots: readonly string[]): string[] => [
  'const S = F.states, M = F.memories, L = F.locals, SD = F.stateDirty, MD = F.memoryDirty, MV = F.memoryViews ?? [], P = F.pins, R = F.resistors;',
  'const BS = F.blockedStates ?? [], BM = F.blockedMemories ?? [];',
  ...(slots.length ? [`let ${slots.join(',')};`] : []),
];

const publish = 'return "invalidated";';

/** The implicit PC write may have been flushed in an earlier batch when resuming. */
function fenceAfterResume(entries: readonly Instruction[], pc: string): string[] {
  const tests = entries.filter((entry) => entry.isolated).map((entry) => `${pc} === ${entry.pc}`);
  return tests.length ? [`if (${tests.join(' || ')}) ${publish}`] : [];
}

/** One function holds the dispatcher, every continuation and every instruction body. */
function monolithicProgram(
  entries: readonly Instruction[],
  binding: DirectJitBinding,
  registers: readonly string[],
): string[] {
  const fence = fenceAfterResume(entries, `S[${binding.pc.index}]`);
  const lines = [
    'function run(F, deadline) {',
    ...prelude(registers),
    'while (true) {',
    'if (F.time >= deadline) return "deadline";',
    'if (F.resume !== 0) {',
    'if (F.due >= deadline) { F.time = deadline; return "deadline"; }',
    'F.time = Math.max(F.time, F.due);',
    'switch (F.resume) {',
  ];
  entries.forEach((entry, index) => {
    lines.push(`case ${index + 1}: {`);
    entry.slots.forEach((slot, slotIndex) => lines.push(`${slot} = L[${slotIndex}];`));
    lines.push(
      'F.resume = 0;',
      ...entry.suffix,
      ...(entry.stop ? [] : fence),
      entry.isolated ? publish : finish(entry.stop),
      '}',
    );
  });
  lines.push(
    'default: throw new TypeError("Unknown direct JIT continuation");',
    '}',
    '}',
    'if (F.stopAfterInstruction) return "invalidated";',
    `switch (H.checkPc(S[${binding.pc.index}])) {`,
  );
  entries.forEach((entry, index) => {
    lines.push(
      `case ${entry.pc}: {`,
      ...entry.barrier,
      ...entry.guard,
      `S[${binding.pc.index}] = ${entry.nextPc};`,
      dirty('SD', binding.pc.index),
      ...entry.prefix,
    );
    if (entry.duration !== undefined) lines.push(...elapsed(entry, index + 1));
    lines.push(...entry.suffix, entry.isolated ? publish : finish(entry.stop), '}');
  });
  lines.push('default: return "fallback";', '}', '}', '}');
  return lines;
}

/** A light dispatcher plus one step/resume shard keeps every generated function small. */
function shardProgram(
  entries: readonly Instruction[],
  binding: DirectJitBinding,
  shardSize: number,
): string[] {
  const fence = fenceAfterResume(entries, `S[${binding.pc.index}]`);
  const sorted = [...entries].sort((left, right) => left.pcValue - right.pcValue);
  // Generated function size follows the emitted source, so group by a code budget instead of
  // a fixed count: one oversized block then gets a shard of its own.
  const groups: Instruction[][] = [];
  let current: Instruction[] = [];
  let budget = 0;
  for (const entry of sorted) {
    if (
      current.length &&
      (current.length >= shardSize || budget + entry.size > SHARD_CODE_BUDGET)
    ) {
      groups.push(current);
      current = [];
      budget = 0;
    }
    current.push(entry);
    budget += entry.size;
  }
  if (current.length) groups.push(current);
  let start = 0;
  const shards = groups.map((slice) => {
    const shard = {
      start,
      entries: slice,
      maxSlots: Math.max(...slice.map((entry) => entry.slots.length)),
      lastPc: slice[slice.length - 1]!.pc,
      lastResume: start + slice.length,
      resumable: slice.some((entry) => entry.duration !== undefined),
    };
    start += slice.length;
    return shard;
  });
  const registers = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `v${index}`);
  const lines: string[] = [];
  shards.forEach((shard, shardIndex) => {
    const lower = shardIndex ? shards[shardIndex - 1]!.lastPc : undefined;
    lines.push(
      `function stepShard${shardIndex}(F, deadline, pc) {`,
      ...prelude(registers(shard.maxSlots)),
      'while (true) {',
      'switch (pc) {',
    );
    shard.entries.forEach((entry, offset) => {
      lines.push(
        `case ${entry.pc}: {`,
        ...entry.barrier,
        ...entry.guard,
        `S[${binding.pc.index}] = ${entry.nextPc};`,
        dirty('SD', binding.pc.index),
        ...entry.prefix,
        ...elapsed(entry, shard.start + offset + 1),
        ...entry.suffix,
        entry.isolated ? publish : stepFinish(entry.stop, lower, shard.lastPc, binding.pc.index),
        '}',
      );
    });
    lines.push('default: return "fallback";', '}', '}', '}');
  });
  shards.forEach((shard, shardIndex) => {
    if (!shard.resumable) return;
    lines.push(
      `function resumeShard${shardIndex}(F, resume) {`,
      ...prelude(registers(shard.maxSlots)),
      'switch (resume) {',
    );
    shard.entries.forEach((entry, offset) => {
      if (entry.duration === undefined) return;
      lines.push(`case ${shard.start + offset + 1}: {`);
      entry.slots.forEach((slot, slotIndex) => lines.push(`${slot} = L[${slotIndex}];`));
      lines.push(
        'F.resume = 0;',
        ...entry.suffix,
        ...(entry.stop ? [] : fence),
        entry.isolated ? publish : splitFinish(entry.stop),
        '}',
      );
    });
    lines.push('default: throw new TypeError("Unknown direct JIT continuation");', '}', '}');
  });
  lines.push(
    'function run(F, deadline) {',
    'const S = F.states;',
    'while (true) {',
    'if (F.time >= deadline) return "deadline";',
    'let status;',
    'if (F.resume !== 0) {',
    'if (F.due >= deadline) { F.time = deadline; return "deadline"; }',
    'F.time = Math.max(F.time, F.due);',
    'const resume = F.resume;',
  );
  const resumable = shards
    .map((shard, shardIndex) => ({ shard, shardIndex }))
    .filter(({ shard }) => shard.resumable);
  if (resumable.length) {
    emitShardRoutes(
      lines,
      'resume',
      resumable.map(({ shard, shardIndex }) => ({
        bound: String(shard.lastResume),
        call: `status = resumeShard${shardIndex}(F, resume);`,
      })),
      'throw new TypeError("Unknown direct JIT continuation");',
    );
  } else lines.push('throw new TypeError("Unknown direct JIT continuation");');
  lines.push(
    '} else {',
    'if (F.stopAfterInstruction) return "invalidated";',
    `const pc = S[${binding.pc.index}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc);`,
  );
  emitShardRoutes(
    lines,
    'pc',
    shards.map((shard, shardIndex) => ({
      bound: String(shard.lastPc),
      call: `status = stepShard${shardIndex}(F, deadline, pc);`,
    })),
    'return "fallback";',
  );
  lines.push('}', 'if (status !== "next") return status;', '}', '}');
  return lines;
}

function sameInstructions(left: readonly Instruction[], right: readonly Instruction[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function refreshShard(shard: ResidentShard): void {
  shard.entries.sort((left, right) => left.pcValue - right.pcValue);
  shard.sourceSize = shard.entries.reduce((sum, entry) => sum + entry.size, 0);
  shard.maxSlots = Math.max(0, ...shard.entries.map((entry) => entry.slots.length));
  shard.resumable = shard.entries.some((entry) => entry.duration !== undefined);
}

function shardCanAccept(shard: ResidentShard, entry: Instruction, shardSize: number): boolean {
  return shard.entries.length < shardSize && shard.sourceSize + entry.size <= SHARD_CODE_BUDGET;
}

/**
 * Group instructions into control-flow chains (loop backedges, local calls and sequential
 * fallthroughs) so related hot blocks stay in the same shard and fall through across `case`s.
 */
function buildEntryChains(
  entries: readonly Instruction[],
  pcIndex: number,
): readonly (readonly Instruction[])[] {
  if (entries.length <= 1) return entries.length ? [entries] : [];
  const byPc = new Map<number, Instruction>();
  for (const entry of entries) byPc.set(entry.pcValue, entry);
  const pcAssignPrefix = `S[${pcIndex}] = `;
  const succ = new Map<Instruction, Instruction>();
  for (const entry of entries) {
    const target = preferredSuccessor(entry, byPc, pcAssignPrefix);
    if (target !== undefined) succ.set(entry, target);
  }
  const pred = new Map<Instruction, Instruction>();
  const selectedSucc = new Map<Instruction, Instruction>();
  const rankEdge = (u: Instruction, v: Instruction): number => {
    if (u.pcValue > v.pcValue) return 3;
    if (u.nextPcValue === v.pcValue) return 2;
    return 1;
  };
  const betterPred = (
    candidate: Instruction,
    current: Instruction,
    target: Instruction,
  ): boolean => {
    const rCand = rankEdge(candidate, target);
    const rCurr = rankEdge(current, target);
    if (rCand !== rCurr) return rCand > rCurr;
    if (rCand === 2) return candidate.pcValue < current.pcValue;
    return candidate.pcValue > current.pcValue;
  };
  for (const [u, v] of succ) {
    const current = pred.get(v);
    if (current === undefined || betterPred(u, current, v)) {
      if (current !== undefined) selectedSucc.delete(current);
      pred.set(v, u);
      selectedSucc.set(u, v);
    }
  }
  const chains: Instruction[][] = [];
  const emitted = new Set<Instruction>();
  for (const entry of entries) {
    if (emitted.has(entry) || pred.has(entry)) continue;
    const chain: Instruction[] = [];
    let cursor: Instruction | undefined = entry;
    while (cursor !== undefined && !emitted.has(cursor)) {
      emitted.add(cursor);
      chain.push(cursor);
      cursor = selectedSucc.get(cursor);
    }
    chains.push(chain);
  }
  for (const entry of entries) {
    if (emitted.has(entry)) continue;
    const chain: Instruction[] = [];
    let cursor: Instruction | undefined = entry;
    while (cursor !== undefined && !emitted.has(cursor)) {
      emitted.add(cursor);
      chain.push(cursor);
      cursor = selectedSucc.get(cursor);
    }
    chains.push(chain);
  }
  return chains;
}

function orderShardEntries(
  entries: readonly Instruction[],
  pcIndex: number,
): readonly Instruction[] {
  if (entries.length <= 2) return entries;
  return buildEntryChains(entries, pcIndex).flat();
}

/**
 * Reconcile resident shard generations with the current compiled instruction set. The open
 * tail shard can absorb later blocks while closed shards stay immutable and reusable.
 */
function syncResidentShards(
  state: DirectJitCacheState,
  entries: readonly Instruction[],
  shardSize: number,
  pcIndex: number,
): void {
  const active = new Map(entries.map((entry) => [entry.pcValue, entry]));
  const owners = new Map<number, ResidentShard>();

  for (let shardIndex = state.shards.length - 1; shardIndex >= 0; shardIndex--) {
    const shard = state.shards[shardIndex]!;
    const next: Instruction[] = [];
    let changed = false;
    for (const old of shard.entries) {
      const current = active.get(old.pcValue);
      if (current === undefined) {
        changed = true;
        continue;
      }
      if (current !== old) changed = true;
      next.push(current);
    }
    if (changed) {
      shard.entries = next;
      shard.dirty = true;
    }
    if (!next.length) {
      state.shards.splice(shardIndex, 1);
      continue;
    }
    refreshShard(shard);
    for (const entry of shard.entries) owners.set(entry.pcValue, shard);
  }

  const pending = [...active.values()]
    .filter((entry) => !owners.has(entry.pcValue))
    .sort((left, right) => left.pcValue - right.pcValue);
  const chains = buildEntryChains(pending, pcIndex);
  for (const chain of chains) {
    const chainSize = chain.reduce((sum, entry) => sum + entry.size, 0);
    let tail = state.shards[state.shards.length - 1];
    // Keep a connected control-flow chain together when it fits in one fresh shard budget
    // but would be split across the remaining byte budget of the current tail shard.
    if (
      tail !== undefined &&
      tail.entries.length > 0 &&
      chain.length <= shardSize &&
      chainSize <= SHARD_CODE_BUDGET &&
      tail.sourceSize + chainSize > SHARD_CODE_BUDGET
    ) {
      tail = {
        id: state.nextShard++,
        entries: [],
        sourceSize: 0,
        maxSlots: 0,
        resumable: false,
        functions: undefined,
        signature: undefined,
        dirty: true,
      };
      state.shards.push(tail);
    }
    for (const entry of chain) {
      let shard = state.shards[state.shards.length - 1];
      if (shard === undefined || !shardCanAccept(shard, entry, shardSize)) {
        shard = {
          id: state.nextShard++,
          entries: [],
          sourceSize: 0,
          maxSlots: 0,
          resumable: false,
          functions: undefined,
          signature: undefined,
          dirty: true,
        };
        state.shards.push(shard);
      }
      shard.entries.push(entry);
      shard.dirty = true;
      refreshShard(shard);
      owners.set(entry.pcValue, shard);
    }
  }
}

/** Shortest safe membership fast path for the sorted entries of one resident shard. */
function residentPcSpan(entries: readonly Instruction[]): string {
  const first = entries[0]!;
  if (entries.length === 1) return `pc === ${first.pc}`;
  const last = entries[entries.length - 1]!;
  // Every entry lies in this span. Gaps safely reach the shard switch default, which returns
  // the PC to the dispatcher, so two bounds are shorter than enumerating sparse cases.
  return `pc >= ${first.pc} && pc <= ${last.pc}`;
}

function preferredSuccessor(
  entry: Instruction,
  byPc: ReadonlyMap<number, Instruction>,
  pcAssignPrefix: string,
): Instruction | undefined {
  let backward: Instruction | undefined;
  let lastTarget: Instruction | undefined;
  for (const line of entry.prefix) {
    if (!line.startsWith(pcAssignPrefix) || !line.endsWith(';')) continue;
    const targetPc = Number(line.slice(pcAssignPrefix.length, -1));
    if (!Number.isSafeInteger(targetPc) || targetPc === entry.nextPcValue) continue;
    const target = byPc.get(targetPc);
    if (target === undefined || target === entry) continue;
    if (targetPc < entry.pcValue) backward = target;
    lastTarget = target;
  }
  if (backward !== undefined) return backward;
  if (lastTarget !== undefined) return lastTarget;
  const sequential = byPc.get(entry.nextPcValue);
  return sequential !== undefined && sequential !== entry ? sequential : undefined;
}

function residentStepFinish(
  entry: Instruction,
  inside: string | undefined,
  binding: DirectJitBinding,
  fallthrough?: Instruction,
): string {
  if (entry.stop) return 'return "stopped";';
  const emptyInline =
    binding.host === true &&
    entry.duration !== undefined &&
    entry.suffix.length === 0 &&
    !entry.isolated;
  let checkpoint: string;
  if (entry.duration === undefined) {
    // Zero-time blocks have no `elapsed()` site to checkpoint a dynamic publication. Settle
    // the instruction boundary here so a resident shard can continue without a scheduler hop.
    checkpoint =
      binding.host === true
        ? 'if (F.stopAfterInstruction) return "invalidated"; if (F.publishPending && F.finishCheckpoint?.(deadline, false) !== true) return "invalidated"; '
        : 'if (F.stopAfterInstruction || F.publishPending) return "invalidated"; ';
  } else {
    checkpoint = emptyInline
      ? entry.dynamicDuration
        ? 'if (F.publishPending) return "invalidated"; '
        : ''
      : binding.host
        ? `if (F.stopAfterInstruction && !F.finishCheckpoint?.(deadline, ${entry.suffix.length === 0})) return "invalidated"; if (F.publishPending) return "invalidated"; `
        : 'if (F.stopAfterInstruction || F.publishPending) return "invalidated"; ';
  }
  const pcCheck =
    'if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc);';
  if (inside === undefined)
    return `${checkpoint}const pc = S[${binding.pc.index}]; ${pcCheck} return pc;`;
  const read = `pc = S[${binding.pc.index}]; ${pcCheck}`;
  if (fallthrough !== undefined) {
    return `${checkpoint}pc = S[${binding.pc.index}]; if (pc !== ${fallthrough.pc}) { ${pcCheck} if (${inside}) continue; return pc; }`;
  }
  return `${checkpoint}${read} if (${inside}) continue; return pc;`;
}

function residentResumeFinish(stop: boolean, pcIndex: number): string {
  if (stop) return 'return "stopped";';
  return `if (F.stopAfterInstruction || F.publishPending) return "invalidated"; const pc = S[${pcIndex}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc); return pc;`;
}

/** Emit one independent shard factory. Its function object is never edited after creation. */
function residentShardProgram(shard: ResidentShard, binding: DirectJitBinding): string[] {
  const registers = Array.from({ length: shard.maxSlots }, (_, index) => `v${index}`);
  const stepInside = residentPcSpan(shard.entries);
  const orderedEntries = orderShardEntries(shard.entries, binding.pc.index);
  const outlined: string[][] = [];
  const lines = [
    `function stepShard${shard.id}(F, deadline, pc) {`,
    ...prelude(registers),
    'while (true) {',
    'switch (pc) {',
  ];
  orderedEntries.forEach((entry, index) => {
    const fallthrough = orderedEntries[index + 1];
    lines.push(
      `case ${entry.pc}: {`,
      ...entry.barrier,
      ...entry.guard,
      `S[${binding.pc.index}] = ${entry.nextPc};`,
      dirty('SD', binding.pc.index),
      ...entry.outlinePrefix(outlined),
      ...elapsed(entry, entry.resumeId, binding.host === true),
      ...entry.suffix,
      entry.isolated ? publish : residentStepFinish(entry, stepInside, binding, fallthrough),
      '}',
    );
  });
  // A later shard may overlap this shard's numeric span. Falling through to the dispatcher
  // makes the range above a fast path rather than an ownership claim.
  lines.push('default: return pc;', '}', '}', '}');
  if (shard.resumable) {
    lines.push(
      `function resumeShard${shard.id}(F, resume) {`,
      ...prelude(registers),
      'switch (resume) {',
    );
    shard.entries.forEach((entry) => {
      if (entry.duration === undefined) return;
      lines.push(`case ${entry.resumeId}: {`);
      entry.slots.forEach((slot, slotIndex) => lines.push(`${slot} = L[${slotIndex}];`));
      lines.push(
        'F.resume = 0;',
        ...entry.suffix,
        entry.isolated ? publish : residentResumeFinish(entry.stop, binding.pc.index),
        '}',
      );
    });
    lines.push('default: throw new TypeError("Unknown direct JIT continuation");', '}', '}');
  }
  for (const helper of outlined) lines.push(...helper);
  return lines;
}

type ResidentShardFactory = (
  constants: readonly unknown[],
  runtimeHelpers: typeof helpers,
) => [ResidentStep, ResidentResume | undefined];

/**
 * One step/resume pair for an equivalence class. The logical PC and implicit successor are
 * route data: `nextPc` is written at the same order point as an independent shard, and the
 * resume function reads the actual PC the prefix left in `S[pc]`. Every other line is the
 * representative `Instruction`, so checkpoints, publication, deadline and exception
 * behaviour stay identical to the normal shard emitter.
 */
function sharedBodyProgram(
  variant: SharedVariant,
  binding: DirectJitBinding,
  pcIndex: number,
): string[] {
  const entry = variant.instruction;
  const registers = Array.from({ length: entry.slots.length }, (_, index) => `v${index}`);
  const outlined: string[][] = [];
  const lines = [
    `function stepShared${variant.id}(F, deadline, nextPc) {`,
    ...prelude(registers),
    ...entry.barrier,
    ...entry.guard,
    `S[${pcIndex}] = nextPc;`,
    dirty('SD', pcIndex),
    ...entry.outlinePrefix(outlined),
    ...elapsed(entry, variant.resumeId, binding.host === true),
    ...entry.suffix,
    entry.isolated ? publish : residentStepFinish(entry, undefined, binding),
    '}',
  ];
  if (entry.duration !== undefined) {
    lines.push(
      `function resumeShared${variant.id}(F, resume) {`,
      ...prelude(registers),
      ...entry.slots.map((slot, slotIndex) => `${slot} = L[${slotIndex}];`),
      'F.resume = 0;',
      ...entry.suffix,
      entry.isolated ? publish : residentResumeFinish(entry.stop, pcIndex),
      '}',
    );
  }
  for (const helper of outlined) lines.push(...helper);
  return lines;
}

// Share only the unbound factory. Neither the source key nor the factory captures a JIT cache,
// and every caller binds its own constants when it creates the step and resume functions.
const residentFactories = new Map<string, ResidentShardFactory>();
const maxResidentFactories = 128;
const maxResidentFactorySourceUnits = 4 * 1024 * 1024;
// Oversized sources bypass the cache instead of evicting a group of smaller factories.
const maxCachedShardSourceUnits = 64 * 1024;
let residentFactorySourceUnits = 0;

function residentShardFactory(source: string): ResidentShardFactory {
  // The parameter list is fixed for every factory in this cache.
  const cacheable = source.length <= maxCachedShardSourceUnits;
  const previous = cacheable ? residentFactories.get(source) : undefined;
  if (previous !== undefined) {
    residentFactories.delete(source);
    residentFactories.set(source, previous);
    return previous;
  }

  const factory = new Function('C', 'H', source) as ResidentShardFactory;
  if (!cacheable) return factory;
  while (
    residentFactories.size >= maxResidentFactories ||
    residentFactorySourceUnits + source.length > maxResidentFactorySourceUnits
  ) {
    const oldest = residentFactories.keys().next().value!;
    residentFactories.delete(oldest);
    residentFactorySourceUnits -= oldest.length;
  }
  residentFactories.set(source, factory);
  residentFactorySourceUnits += source.length;
  return factory;
}

function compileResidentShard(
  state: DirectJitCacheState,
  shard: ResidentShard,
  binding: DirectJitBinding,
): number {
  const lines = residentShardProgram(shard, binding);
  const resume = shard.resumable ? `resumeShard${shard.id}` : 'undefined';
  const source = `"use strict";\n${lines.join('\n')}\nreturn [stepShard${shard.id}, ${resume}];`;
  const factory = residentShardFactory(source);
  const [step, resumeFunction] = factory(Object.freeze([...state.constants]), helpers);
  shard.functions = { step, resume: resumeFunction };
  shard.signature = Object.freeze([...shard.entries]);
  shard.dirty = false;
  state.stats.compiledShards++;
  return source.length;
}

/** Tiny generated router over resident functions; only this source is rebuilt per program. */
function residentDispatcherProgram(
  shards: readonly ResidentShard[],
  entries: readonly Instruction[],
  binding: DirectJitBinding,
): string[] {
  const shardIndex = new Map<number, number>();
  shards.forEach((shard, index) => {
    for (const entry of shard.entries) shardIndex.set(entry.pcValue, index);
  });
  const sorted = [...entries].sort((left, right) => left.pcValue - right.pcValue);
  const lines = shards.map((_, index) => `const D${index} = SH[${index}];`);
  lines.push(
    'function run(F, deadline) {',
    'const S = F.states;',
    'if (F.time >= deadline) return "deadline";',
    'let pc;',
    'if (F.resume !== 0) {',
    'if (F.due >= deadline) { F.time = deadline; return "deadline"; }',
    'F.time = Math.max(F.time, F.due);',
    'const resume = F.resume;',
    'const resumed = RES[resume];',
    'if (resumed === undefined) throw new TypeError("Unknown direct JIT continuation");',
    'const next = resumed(F, resume);',
    'if (typeof next !== "number") return next;',
    ...fenceAfterResume(entries, 'next'),
    'pc = next;',
    '} else {',
    'if (F.stopAfterInstruction) return "invalidated";',
    `pc = S[${binding.pc.index}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc);`,
    '}',
    'while (true) {',
    'let next;',
    'switch (pc) {',
  );
  let current = -1;
  for (const entry of sorted) {
    const index = shardIndex.get(entry.pcValue)!;
    if (index !== current) {
      if (current >= 0) lines.push(`next = D${current}(F, deadline, pc); break;`);
      current = index;
    }
    lines.push(`case ${entry.pc}:`);
  }
  if (current >= 0) lines.push(`next = D${current}(F, deadline, pc); break;`);
  lines.push(
    'default: return "fallback";',
    '}',
    'if (typeof next !== "number") return next;',
    'pc = next;',
    '}',
    '}',
  );
  return lines;
}

function residentProgram(
  state: DirectJitCacheState,
  entries: readonly Instruction[],
  binding: DirectJitBinding,
  shardSize: number,
): DirectJitProgram | undefined {
  syncResidentShards(state, entries, shardSize, binding.pc.index);
  if (!state.shards.length) return undefined;
  for (const shard of state.shards) {
    if (
      shard.functions !== undefined &&
      !shard.dirty &&
      sameInstructions(shard.signature ?? [], shard.entries)
    ) {
      state.stats.reusedShards++;
      continue;
    }
    compileResidentShard(state, shard, binding);
  }

  const lines = residentDispatcherProgram(state.shards, entries, binding);
  const factory = new Function('SH', 'RES', `"use strict";\n${lines.join('\n')}\nreturn run;`) as (
    shards: readonly ResidentStep[],
    resumes: readonly (ResidentResume | undefined)[],
  ) => (frame: DirectJitFrame, deadline: number) => DirectJitReason;
  const steps = Object.freeze(state.shards.map((shard) => shard.functions!.step));
  const resumeCount = state.nextResume;
  const resumes = new Array<ResidentResume | undefined>(resumeCount);
  for (const shard of state.shards) {
    if (shard.functions!.resume === undefined) continue;
    for (const entry of shard.entries)
      if (entry.resumeId !== 0) resumes[entry.resumeId] = shard.functions!.resume;
  }
  let localCount = 0;
  for (const entry of entries) if (entry.slots.length > localCount) localCount = entry.slots.length;
  const program = {
    run: factory(steps, Object.freeze(resumes)),
    shards: state.shards.length,
    pcs: Object.freeze(entries.map((entry) => entry.pcValue)),
    localCount,
    readStates: resourceNames(entries, 'readStates'),
    writeStates: resourceNames(entries, 'writeStates'),
    readMemories: resourceNames(entries, 'readMemories'),
    writeMemories: resourceNames(entries, 'writeMemories'),
  } satisfies DirectJitProgram;
  Object.defineProperty(program, 'emitStats', { value: emitStats(entries) });
  return Object.freeze(program);
}

/** Split at a deadline or publication; resident host code can keep an admitted suffix inline. */
function elapsed(entry: Instruction, resumeId: number, checkpoint = false): string[] {
  if (entry.duration === undefined) return [];
  // A computed duration is validated where the generic host validates it, before it is used.
  const duration = entry.dynamicDuration
    ? `(Number.isInteger(${entry.duration}) && ${entry.duration} >= 0 && ${entry.duration} <= 7200000000000000 ? ${entry.duration} : H.checkDuration(${entry.duration}))`
    : entry.duration;
  const emptyInline = checkpoint && entry.suffix.length === 0 && !entry.stop && !entry.isolated;
  return [
    `F.due = F.time + ${duration};`,
    'if (F.due > 7200000000000000) throw new RangeError("Time out of range");',
    'if ((F.publishPending && F.due > F.time) || F.due >= deadline) {',
    `F.resume = ${resumeId};`,
    // Inside this split, due < deadline implies a publication. The callback may
    // clear publishPending even when it rejects, so that case must still suspend.
    ...(checkpoint
      ? [
          'if (F.due < deadline && F.publishCheckpoint?.()) {',
          'F.resume = 0;',
          ...(emptyInline
            ? [
                'F.time = F.due;',
                'F.stopAfterInstruction = true;',
                'if (!F.finishCheckpoint?.(deadline, true)) return "invalidated";',
              ]
            : ['F.stopAfterInstruction = true;']),
          '} else {',
        ]
      : []),
    ...entry.slots.map((slot, slotIndex) => `L[${slotIndex}] = ${slot};`),
    checkpoint
      ? 'if (F.due < deadline || (F.publishPending && F.due > F.time)) return "invalidated";'
      : 'if (F.publishPending && F.due > F.time) return "invalidated";',
    'F.time = deadline;',
    'return "deadline";',
    ...(checkpoint ? ['}'] : []),
    ...(emptyInline ? ['} else F.time = F.due;'] : ['}', 'F.time = F.due;']),
  ];
}

function finish(stop: boolean): string {
  return stop
    ? 'return "stopped";'
    : 'if (F.stopAfterInstruction || F.publishPending) return "invalidated"; continue;';
}

function splitFinish(stop: boolean): string {
  return stop
    ? 'return "stopped";'
    : 'if (F.stopAfterInstruction || F.publishPending) return "invalidated"; return "next";';
}

/**
 * A condition slot holds a boolean in every conforming program, so the type check is a
 * `typeof` test inlined at the use site; the host helper only runs on the failure path.
 * A call per condition dominated small instruction blocks.
 */
function guard(condition: string): string {
  return `(typeof ${condition} === "boolean" ? ${condition} : H.checkBoolean(${condition}))`;
}

/**
 * A shard keeps executing while the next PC still routes to it, which removes the
 * dispatcher hop (and its range checks) from every instruction inside one shard. The
 * bounds repeat the dispatcher's own routing predicate, so a PC outside them returns
 * exactly as before.
 */
function stepFinish(
  stop: boolean,
  lower: string | undefined,
  upper: string,
  pcIndex: number,
): string {
  if (stop) return 'return "stopped";';
  const inside = lower === undefined ? `pc <= ${upper}` : `pc <= ${upper} && pc > ${lower}`;
  // The finite-number guard is inlined: a call per instruction costs more than the test.
  return `if (F.stopAfterInstruction || F.publishPending) return "invalidated"; pc = S[${pcIndex}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc); if (${inside}) continue; return "next";`;
}

function dirty(bank: 'SD' | 'MD', index: number): string {
  return `${bank}[${index >>> 5}] |= ${1 << (index & 31)};`;
}

function validIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a redirect sits inside a nested statement branch rather than at the top level. */
function hasBranchRedirect(region: RegionIR): boolean {
  return region.operations.some(redirectInOperation);
}

/** A redirect anywhere in this region, including its own operation list. */
function regionHasRedirect(region: RegionIR): boolean {
  return region.operations.some(
    (operation) => operation.kind === 'redirect' || redirectInOperation(operation),
  );
}

function redirectInOperation(operation: OperationIR): boolean {
  switch (operation.kind) {
    case 'redirect':
      // A top-level redirect keeps the original linear terminal path.
      return false;
    case 'if':
      return (
        regionHasRedirect(operation.yes) ||
        (operation.no !== undefined && regionHasRedirect(operation.no))
      );
    case 'match':
      return (
        operation.arms.some((arm) => regionHasRedirect(arm.body)) ||
        (operation.otherwise !== undefined && regionHasRedirect(operation.otherwise))
      );
    case 'while':
      return regionHasRedirect(operation.test.body) || regionHasRedirect(operation.body);
    case 'loop':
      return regionHasRedirect(operation.body);
    case 'and':
    case 'or':
      return regionHasRedirect(operation.right.body);
    case 'select':
      return regionHasRedirect(operation.yes.body) || regionHasRedirect(operation.no.body);
    case 'assert':
      return operation.message !== undefined && regionHasRedirect(operation.message.body);
    default:
      return false;
  }
}

class Instruction {
  readonly readStates = new Set<string>();
  readonly writeStates = new Set<string>();
  readonly readMemories = new Set<string>();
  readonly writeMemories = new Set<string>();
  slots: string[] = [];
  /** Emitted source characters (bodies and guard); bounds the size of one generated function. */
  size = 0;
  /** Emitted statements, reported by `emitStats` against the block's IR operation count. */
  statements = 0;
  /** IR operations in this block, folded or not: the denominator of the statement ratio. */
  operations = 0;
  /** Labeled `select` blocks that survived the pure-expression form. */
  selects = 0;
  /** Generated source characters of `compileFunction`; zero for instruction bodies. */
  functionSourceSize = 0;
  /** Operations whose statement was removed by folding; the counterfactual of `statements`. */
  foldedOperations = 0;
  /** IR operations anywhere in the block, nested value and statement regions included. */
  nestedOperations = 0;
  /** Emitted before the implicit PC write; a declared busy-wait head folds rounds here. */
  readonly guard: string[] = [];
  /** Entry test against the runtime write barrier; empty when the block writes no slot. */
  barrier: string[] = [];
  prefix: string[] = [];
  suffix: string[] = [];
  /** Numeric instruction key; shards sort by it while `pc` holds the emitted literal. */
  pcValue = 0;
  nextPcValue = 0;
  pc = '';
  nextPc = '';
  /** Cache-stable continuation key used by resident shards; zero when none is needed. */
  resumeId = 0;
  duration?: string;
  /** Set when `duration` is a computed slot instead of a compile-time literal. */
  dynamicDuration = false;
  /** Zero-duration terminator: no due time, no continuation, prefix and suffix stay inline. */
  immediate = false;
  stop = false;
  /** Publish before and after a synchronous loop instruction. */
  get isolated(): boolean {
    return this.backedges !== undefined;
  }
  private backedges?: { lines: string[]; head: number; tail: number }[];
  private outlineBranches?: { start: number; end: number }[];
  private readonly values = new Map<number, string>();
  private readonly locals = new Map<number, string>();
  /**
   * Compile-time known primitive results. These emit no statement at all: every use inlines
   * the literal instead, so a constant used by an operation costs zero statements rather
   * than one.
   */
  private readonly folded = new Map<number, Folded>();
  /** Constant values the reference analyzer proved for this body; undefined if it declined. */
  private constants?: ReadonlyMap<number, Primitive>;
  /** Slots this block writes; the runtime barrier is emitted from these indices. */
  private readonly writtenStates = new Set<number>();
  private readonly writtenMemories = new Set<number>();
  /** Results whose type is an object value; identity comparison would change their meaning. */
  private readonly references = new Set<number>();
  /** Results whose emitted operations guarantee booleans, not just declared bool types. */
  private readonly booleanResults = new Set<number>();
  /** Label of the block that wraps conditional exits; undefined for linear bodies. */
  private exitLabel: string | undefined;
  /** Slot holding the duration of whichever exit path ran. */
  private exitDuration: string | undefined;
  private labels = 0;

  constructor(
    private readonly binding: DirectJitBinding,
    private readonly capture: (value: unknown) => string,
    private readonly resistorSlot?: (pin: string, resistance: number) => number,
    private readonly resolveFunction?: ResolveFunction,
    private readonly fn?: DirectFunctionIR,
  ) {}

  compileFunction(constants: readonly unknown[]): unknown {
    const fn = this.fn!;
    const scalar = (type: { readonly kind: string }): boolean =>
      type.kind === 'number' || type.kind === 'bool';
    if (fn.params.some(({ type }) => !scalar(type)) || (fn.returns && !scalar(fn.returns)))
      throw unsupported;
    this.constants = constantsOf(fn.body);
    this.region(fn.body, this.prefix);
    // Loops in instructions use special publication fences; decline them in helpers.
    if (this.isolated) throw unsupported;
    this.compact();
    const params = fn.params.map((_, index) => `a${index}`);
    const lines = [...prelude(this.slots), ...this.prefix];
    const source = `"use strict"; return function(F${params.map((param) => `,${param}`).join('')}) {\n${lines.join('\n')}\n};`;
    this.functionSourceSize = source.length;
    return new Function('C', 'H', source)(Object.freeze([...constants]), helpers);
  }

  compile(instruction: { pc: number; nextPc: number; body: RegionIR }): this {
    this.pcValue = instruction.pc;
    this.nextPcValue = instruction.nextPc;
    this.constants = constantsOf(instruction.body);
    const shape = shapeOf(instruction.body);
    this.operations = shape.operations;
    this.nestedOperations = shape.nestedOperations;
    this.pc = this.literal(instruction.pc);
    this.nextPc = this.literal(instruction.nextPc);
    this.readStates.add(this.binding.pc.name);
    this.state(this.binding.pc.name, true);
    const delay = this.binding.delayLoops?.get(instruction.pc);
    if (delay !== undefined && validIndex(delay.counter) && validIndex(delay.cycles)) {
      const pending = delay.pending;
      const paced =
        pending !== undefined &&
        validIndex(pending.state) &&
        validIndex(pending.period) &&
        validIndex(pending.active)
          ? pending
          : undefined;

      this.guard.push(
        `if (S[${delay.counter}] > 1) {`,
        // Fold only the rounds that end before the horizon: the deadline split stays exact,
        // and a short horizon still makes progress instead of failing to skip at all.
        `let rounds = Math.min(S[${delay.counter}] - 1, Math.floor((deadline - F.time) / ${delay.cycles}));`,
      );
      if (paced !== undefined)
        this.guard.push(
          // A paced device consumes time through its service accumulator; stop on the first
          // round that reaches the next service boundary, so the following dispatch still
          // advances SysTick / the UART bit clock by exactly the folded time.
          `if (S[${paced.active}]) rounds = Math.min(rounds, Math.floor(Math.max(0, S[${paced.period}] - S[${paced.state}]) / ${delay.cycles}) + 1);`,
        );
      this.guard.push(
        'if (rounds > 0) {',
        `F.time += rounds * ${delay.cycles};`,
        'if (F.time > 7200000000000000) throw new RangeError("Time out of range");',
        `S[${delay.counter}] = S[${delay.counter}] - rounds;`,
        dirty('SD', delay.counter),
        ...(paced !== undefined
          ? [`S[${paced.state}] += rounds * ${delay.cycles};`, dirty('SD', paced.state)]
          : []),
        '}',
        'if (F.time >= deadline) { F.time = deadline; return "deadline"; }',
        '}',
      );
    }
    let output = this.prefix;
    let terminal = false;
    if (hasBranchRedirect(instruction.body)) {
      // A redirect inside a branch terminates the instruction from a nested position, while
      // the linear operations after that branch and the tail `elapse` still belong to every
      // path that did not redirect. One labeled body plus a shared duration slot turns the
      // conditional redirects and the tail elapse into a single continuation.
      this.compileConditional(instruction.body.operations);
    } else {
      for (const operation of instruction.body.operations) {
        if (terminal) throw unsupported;
        if (operation.kind === 'elapse') {
          if (this.terminated) throw unsupported;
          this.terminate(this.delay(operation.duration));
          output = this.suffix;
        } else if (operation.kind === 'redirect') {
          if (this.terminated) throw unsupported;
          const delay = this.delay(operation.delay);
          output.push(
            `S[${this.binding.pc.index}] = H.checkPc(${this.value(operation.target)});`,
            dirty('SD', this.binding.pc.index),
          );
          this.terminate(delay);
          output = this.suffix;
          terminal = true;
        } else if (operation.kind === 'stop') {
          this.stop = true;
          terminal = true;
        } else if (operation.kind === 'yield') {
          // A bare yield carries no result. Model validation rejects it today, so only the
          // tail-of-body shape is admitted: any later operation is dead code and declines the
          // whole block. Treating it as a zero-duration exit reuses the `elapse 0` path, which
          // advances no time and needs no continuation slot.
          if (this.terminated) throw unsupported;
          this.terminate({ value: '0', zero: true, dynamic: false });
          terminal = true;
        } else {
          this.operation(operation, output);
        }
      }
    }
    if (!this.terminated && !this.stop) throw unsupported;
    // Admit synchronous, zero-time instructions only; no continuation or delay folding
    // may cross the loop's publication boundary. A conditional-exit body is the exception:
    // its loop runs entirely inside the prefix, the conditional redirects break out after
    // the loop, and the empty suffix publishes on resume (see the assembly sites).
    if (
      this.isolated &&
      this.exitLabel === undefined &&
      (!this.immediate || this.stop || this.guard.length)
    )
      throw unsupported;
    this.compact();
    this.barrier = this.emitBarrier();
    let size = 0;
    let statements = 0;
    let selects = 0;
    for (const block of [this.barrier, this.guard, this.prefix, this.suffix])
      for (const line of block) {
        size += line.length;
        statements += countStatements(line);
        if (isSelectLabel(line)) selects++;
      }
    this.size = size;
    this.statements = statements;
    this.selects = selects;
    return this;
  }

  /**
   * Compile a body whose redirects live inside conditional branches and whose tail is an
   * `elapse`. Each redirect writes the shared exit duration slot, writes the destination PC
   * and breaks out of the labeled body, so the linear operations that follow the branch only
   * run when no redirect fired. The tail `elapse` writes the same slot with its own duration;
   * the assembler then emits one `elapsed` site and one continuation for both exit classes.
   */
  private compileConditional(operations: readonly OperationIR[]): void {
    const tail = operations[operations.length - 1];
    // The tail elapse supplies the duration for every path that did not redirect.
    if (tail?.kind !== 'elapse' || this.guard.length) throw unsupported;
    const label = `exit${this.labels++}`;
    const duration = this.slot();
    this.exitDuration = duration;
    this.exitLabel = label;
    this.prefix.push(`${label}: {`);
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      if (operation.kind === 'elapse') {
        // Only the tail elapse is admitted: an earlier one would terminate the instruction on
        // a path that then never reaches the conditional branch.
        if (index !== operations.length - 1) throw unsupported;
        this.prefix.push(`${duration} = ${this.delay(operation.duration).value};`);
      } else if (
        operation.kind === 'redirect' ||
        operation.kind === 'stop' ||
        operation.kind === 'yield'
      ) {
        // A top-level exit while a conditional exit exists has no unified duration slot.
        throw unsupported;
      } else {
        this.operation(operation, this.prefix);
      }
    }
    this.prefix.push('}');
    this.duration = duration;
    this.dynamicDuration = true;
  }

  /**
   * Entry write barrier. Only slots read by `beforeInstruction` (and the code memory) are
   * checked before an instruction starts; ordinary observer slots publish dynamically at a
   * write site and are checkpointed at the next instruction boundary. Keeping this split means
   * a block can stay resident while observers move, without weakening hook-prefix semantics.
   */
  private emitBarrier(): string[] {
    const lines: string[] = [];
    // The implicit PC write marks any instruction already executed in this batch. Publish
    // that prefix first, then enter the loop in a fresh batch with fresh entry masks.
    if (this.isolated) {
      const pc = this.binding.pc.index;
      lines.push(`if (SD[${pc >>> 5}] & ${(1 << (pc & 31)) >>> 0}) ${publish}`);
    }
    const emit = (
      bank: 'BS' | 'BM',
      written: ReadonlySet<number>,
      names: ReadonlySet<string> | undefined,
      slots: ReadonlyMap<string, number>,
    ): void => {
      if (!names?.size || !written.size) return;
      const indices = new Set<number>();
      for (const name of names) {
        const index = slots.get(name);
        if (validIndex(index) && written.has(index)) indices.add(index);
      }
      if (!indices.size) return;
      const words = new Map<number, number>();
      for (const index of indices)
        words.set(index >>> 5, (words.get(index >>> 5) ?? 0) | (1 << (index & 31)));
      for (const [word, mask] of [...words].sort(([left], [right]) => left - right))
        lines.push(`if (${bank}[${word}] & ${mask >>> 0}) return "fallback";`);
    };
    emit('BS', this.writtenStates, this.binding.entryBlockedStates, this.binding.states);
    emit('BM', this.writtenMemories, this.binding.entryBlockedMemories, this.binding.memories);
    return lines;
  }

  private get terminated(): boolean {
    return this.duration !== undefined || this.immediate;
  }

  /** Keep the short path in the resident step function, without changing shard placement. */
  outlinePrefix(helpers: string[][]): readonly string[] {
    if (
      // A labeled body makes `break exit` visible to this function; outlining would move it
      // into a nested function where that label is out of scope.
      this.exitLabel !== undefined ||
      this.size <= SHARD_CODE_BUDGET ||
      this.slots.length > OUTLINE_MAX_SLOTS ||
      this.isolated ||
      !this.outlineBranches
    )
      return this.prefix;

    const lines: string[] = [];
    const slots = this.slots.join(',');
    const params = ['F', 'S', 'M', 'SD', 'MD', 'MV', 'P', 'R', 'BS', 'BM', ...this.slots].join(',');
    let cursor = 0;
    // Prefer the outer branch when candidates nest. Its whole body already moves off
    // the short path, so there is no need to add calls inside that body.
    for (const { start, end } of this.outlineBranches.sort((a, b) => a.start - b.start)) {
      if (start < cursor) continue;
      const name = `outlined${helpers.length}`;
      lines.push(...this.prefix.slice(cursor, start));
      const call = `${name}(${params});`;
      if (slots) {
        lines.push(`const result = ${call}`);
        this.slots.forEach((slot, index) => lines.push(`${slot} = result[${index}];`));
      } else lines.push(call);
      // Compact slot names are already fixed. Pass them by value and copy them back
      // on normal return. State and memory banks (including dirty masks) are shared
      // directly, so completed writes remain visible if the helper throws.
      helpers.push([
        `function ${name}(${params}) {`,
        ...this.prefix.slice(start, end),
        ...(slots ? [`return [${slots}];`] : []),
        '}',
      ]);
      cursor = end;
    }
    lines.push(...this.prefix.slice(cursor));
    return lines;
  }

  /**
   * Register reuse. Every IR result takes its own virtual slot, and a fully decoded Thumb
   * instruction produces well over a thousand of them: the generated function then carries
   * a thousand locals, which keeps V8 from optimising it and makes every execution pay for
   * a huge frame. Values whose live ranges do not overlap can share one slot, so the
   * emitted lines are scanned once: a slot is allocated at its definition and released
   * after the last line that mentions it. Slots assigned more than once (locals, branch
   * outputs) keep the same slot from the first definition through the last use.
   */
  private compact(): void {
    const total = this.slots.length;
    // A single virtual slot cannot be reused and every emitted token already names it, so
    // compaction is the identity. Constant-only bodies arrive here with no slots at all.
    if (total <= 1) return;
    const bound = this.prefix.length;
    // `elapsed()` reads the duration between the prefix and the suffix, so the slot stays
    // live through the whole prefix even though the emitted use is not part of either block.
    // Without this boundary use the slot looks dead after its definition and a later prefix
    // value reuses it, silently replacing the duration (for example with zero).
    const duration = this.duration === undefined ? [] : [this.duration];
    const lines = [...this.prefix, ...duration, ...this.suffix];
    const lineCount = lines.length;
    const offsets = new Int32Array(lineCount + 1);
    const definitions = new Int32Array(lineCount).fill(-1);
    const firstDefinition = new Int32Array(total).fill(-1);
    const lastDefinition = new Int32Array(total).fill(-1);
    const lastUse = new Int32Array(total).fill(-1);
    const end = new Int32Array(total).fill(-1);
    const tokens: number[] = [];

    // The previous implementation scanned every line twice with `/\bv\d+\b/` and allocated a
    // Map entry per virtual slot. This pass keeps the same token boundaries but stores
    // definitions and uses in dense arrays plus one flat token buffer.
    for (let index = 0; index < lineCount; index++) {
      offsets[index] = tokens.length;
      const line = lines[index]!;
      let position = 0;
      if (line.charCodeAt(0) === 118) {
        let cursor = 1;
        let virtual = 0;
        while (cursor < line.length && isAsciiDigit(line.charCodeAt(cursor))) {
          virtual = virtual * 10 + (line.charCodeAt(cursor) - 48);
          cursor++;
        }
        if (
          cursor > 1 &&
          line.charCodeAt(cursor) === 32 &&
          line.charCodeAt(cursor + 1) === 61 &&
          line.charCodeAt(cursor + 2) === 32
        ) {
          if (virtual >= total) return;
          definitions[index] = virtual;
          if (firstDefinition[virtual]! < 0) firstDefinition[virtual] = index;
          lastDefinition[virtual] = index;
          position = cursor + 3;
        }
      }
      while (position < line.length) {
        if (line.charCodeAt(position) === 34) {
          position = afterString(line, position);
          continue;
        }
        if (line.charCodeAt(position) !== 118) {
          position++;
          continue;
        }
        if (position > 0 && isWordCode(line.charCodeAt(position - 1))) {
          position++;
          continue;
        }
        let cursor = position + 1;
        let virtual = 0;
        while (cursor < line.length && isAsciiDigit(line.charCodeAt(cursor))) {
          virtual = virtual * 10 + (line.charCodeAt(cursor) - 48);
          cursor++;
        }
        if (cursor === position + 1) {
          position++;
          continue;
        }
        if (cursor < line.length && isWordCode(line.charCodeAt(cursor))) {
          position = cursor;
          continue;
        }
        if (virtual >= total) return;
        tokens.push(virtual);
        lastUse[virtual] = index;
        position = cursor;
      }
    }
    offsets[lineCount] = tokens.length;

    // Only the define-before-use shape is compacted; anything else keeps the virtual slots,
    // which is always correct.
    for (let index = 0; index < lineCount; index++)
      for (let token = offsets[index]!; token < offsets[index + 1]!; token++) {
        const virtual = tokens[token]!;
        if (firstDefinition[virtual]! < 0 || firstDefinition[virtual]! > index) return;
      }

    for (let virtual = 0; virtual < total; virtual++)
      if (lastDefinition[virtual]! >= 0)
        end[virtual] = Math.max(lastDefinition[virtual]!, lastUse[virtual]!);

    // A slot defined before a loop and touched in it must keep its physical register
    // across the backedge, even if its last textual use is near the top of the loop.
    // This also covers writes to outer locals and values captured by nested loops.
    const backedgeEnds = this.backedges && new Map<number, number[]>();
    for (const edge of this.backedges ?? []) {
      const offset = edge.lines === this.prefix ? 0 : bound + duration.length;
      const head = offset + edge.head;
      const tail = offset + edge.tail;
      const release: number[] = [];
      const extend = (slot: number): void => {
        if (firstDefinition[slot]! < head && end[slot]! < tail) {
          end[slot] = tail;
          release.push(slot);
        }
      };
      for (let index = head; index < tail; index++) {
        const definition = definitions[index]!;
        if (definition >= 0) extend(definition);
        for (let token = offsets[index]!; token < offsets[index + 1]!; token++)
          extend(tokens[token]!);
      }
      if (release.length) backedgeEnds!.set(tail, release);
    }

    const physical = new Int32Array(total).fill(-1);
    const free: number[] = [];
    let count = 0;
    for (let index = 0; index < lineCount; index++) {
      const definition = definitions[index]!;
      if (definition >= 0 && physical[definition]! < 0)
        physical[definition] = free.length > 0 ? free.pop()! : count++;
      if (definition >= 0 && end[definition] === index) {
        end[definition] = -1;
        free.push(physical[definition]!);
      }
      for (let token = offsets[index]!; token < offsets[index + 1]!; token++) {
        const virtual = tokens[token]!;
        if (end[virtual] !== index) continue;
        end[virtual] = -1;
        free.push(physical[virtual]!);
      }
      const release = backedgeEnds?.get(index);
      if (release)
        for (const virtual of release) {
          if (end[virtual] !== index) continue;
          end[virtual] = -1;
          free.push(physical[virtual]!);
        }
    }

    const names = Array.from({ length: count }, (_, index) => `v${index}`);
    const rewrite = (line: string): string => {
      let output = '';
      let cursor = 0;
      let scan = 0;
      while (scan < line.length) {
        if (line.charCodeAt(scan) === 34) {
          scan = afterString(line, scan);
          continue;
        }
        if (line.charCodeAt(scan) !== 118) {
          scan++;
          continue;
        }
        if (scan > 0 && isWordCode(line.charCodeAt(scan - 1))) {
          scan++;
          continue;
        }
        let position = scan + 1;
        let virtual = 0;
        while (position < line.length && isAsciiDigit(line.charCodeAt(position))) {
          virtual = virtual * 10 + (line.charCodeAt(position) - 48);
          position++;
        }
        if (
          position === scan + 1 ||
          (position < line.length && isWordCode(line.charCodeAt(position)))
        ) {
          scan = position;
          continue;
        }
        const slot = virtual < total ? physical[virtual]! : -1;
        if (slot < 0) {
          scan = position;
          continue;
        }
        output += line.slice(cursor, scan);
        output += names[slot]!;
        cursor = position;
        scan = position;
      }
      return cursor === 0 ? line : output + line.slice(cursor);
    };
    for (let index = 0; index < bound; index++) this.prefix[index] = rewrite(this.prefix[index]!);
    for (let index = 0; index < this.suffix.length; index++)
      this.suffix[index] = rewrite(this.suffix[index]!);
    if (this.duration !== undefined) this.duration = rewrite(this.duration);
    this.slots = names;
  }

  /** A zero duration advances no time, so the instruction needs no continuation slot. */
  private terminate(delay: { value: string; zero: boolean; dynamic: boolean }): void {
    if (delay.zero) this.immediate = true;
    else {
      this.duration = delay.value;
      this.dynamicDuration = delay.dynamic;
    }
  }

  private delay(id: number): { value: string; zero: boolean; dynamic: boolean } {
    const folded = this.folded.get(id);
    if (folded !== undefined && typeof folded.value === 'number') {
      // A folded duration is validated at compile time by the same helper the runtime uses;
      // a rejected value declines the block, so the interpreter raises the original error.
      try {
        checkDuration(folded.value);
      } catch {
        throw unsupported;
      }
      return { value: folded.text, zero: folded.value === 0, dynamic: false };
    }
    // A computed duration keeps its slot: the emitted body validates it at the operation's
    // own position, exactly like the generator backend's `H.checkDuration`.
    const slot = this.values.get(id);
    if (slot === undefined) throw unsupported;
    return { value: slot, zero: false, dynamic: true };
  }

  /**
   * Literal source text for values the compiler has already validated as primitive numbers or
   * booleans. NaN, infinities and non-safe integers keep travelling as closure data.
   */
  private literal(value: unknown): string {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return Object.is(value, -0) ? '-0' : String(value);
    }
    if (typeof value === 'string') {
      // JSON encoding is a complete, injection-safe JavaScript string literal; the line
      // separators need escaping for older parsers but remain the same string at runtime.
      return JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    }
    return this.capture(value);
  }

  private value(id: number): string {
    const slot = this.expressionOf(id);
    if (!slot) throw unsupported;
    return slot;
  }

  /** A compiled value: its slot when it has one, otherwise the inlined literal text. */
  private expressionOf(id: number): string | undefined {
    return this.values.get(id) ?? this.folded.get(id)?.text;
  }

  /**
   * A condition slot holds a boolean in every conforming program, so the type check is a
   * `typeof` test inlined at the use site; the host helper only runs on the failure path.
   * A call per condition dominated small instruction blocks. Constants and operators that
   * can only produce a boolean need no test at all.
   */
  private condition(id: number): string {
    const folded = this.folded.get(id);
    if (folded !== undefined && typeof folded.value === 'boolean') return folded.text;
    if (this.booleanResults.has(id)) return this.value(id);
    return guard(this.value(id));
  }

  private isGuaranteedBoolean(id: number): boolean {
    if (this.booleanResults.has(id)) return true;
    const folded = this.folded.get(id);
    return folded !== undefined && typeof folded.value === 'boolean';
  }

  /**
   * Records a value the analyzer proved constant and emits nothing. Only `constant` and the
   * arithmetic shapes the reference analyzer folds qualify: their results are primitives, so
   * the inlined literal reproduces the runtime value bit for bit. Everything else keeps a
   * slot, because its value is only known once the instruction runs — or because evaluating
   * it can throw (`nonNull` of a known null) or allocate (`bytes`).
   */
  private foldResult(operation: OperationIR): boolean {
    if (!('result' in operation)) return false;
    switch (operation.kind) {
      case 'constant': {
        const { constant } = operation;
        if (constant.kind === 'string') return this.foldConstant(operation.result, constant.value);
        if (constant.kind === 'enum') return this.foldConstant(operation.result, constant.member);
        if (constant.kind === 'number' || constant.kind === 'bool')
          return this.foldConstant(operation.result, constant.value);
        return false;
      }
      case 'unary':
      case 'binary':
      case 'numeric': {
        const value = this.constants?.get(operation.result);
        return value === undefined ? false : this.foldConstant(operation.result, value);
      }
      default:
        return false;
    }
  }

  private foldConstant(id: number, value: Primitive): true {
    this.folded.set(id, { value, text: this.literal(value) });
    this.foldedOperations++;
    return true;
  }

  private slot(): string {
    const slot = `v${this.slots.length}`;
    this.slots.push(slot);
    return slot;
  }

  private state(name: string, write: boolean): number {
    const index = this.binding.states.get(name);
    // Ordinary observer slots stay compilable; their writes publish at the instruction boundary.
    if (!validIndex(index) || (write && this.binding.entryBlockedStates?.has(name)))
      throw unsupported;
    (write ? this.writeStates : this.readStates).add(name);
    if (write) this.writtenStates.add(index);
    return index;
  }

  private memory(operation: { readonly kind: string; readonly memory: MemoryRefIR }): number {
    if (operation.memory.kind !== 'memory') throw unsupported;
    const name = operation.memory.name;
    const index = this.binding.memories.get(name);
    const write = operation.kind.startsWith('store');
    // Only entry-blocked stores and self-modifying code remain compile-time barriers. Every
    // load kind, including the wide ones, stays eligible.
    if (!validIndex(index) || (write && this.binding.entryBlockedMemories?.has(name)))
      throw unsupported;
    (write ? this.writeMemories : this.readMemories).add(name);
    if (write) this.writtenMemories.add(index);
    return index;
  }

  /**
   * A value region that is exactly one last yield over pure scalar operations folds into a
   * single expression. Anything else returns undefined and keeps the labeled block.
   */
  private expression(region: ValueRegionIR): string | undefined {
    if (region.type.kind !== 'number' && region.type.kind !== 'bool') return undefined;
    const { operations } = region.body;
    const last = operations[operations.length - 1];
    if (last?.kind !== 'yield') return undefined;
    const values = new Map<number, string>();
    for (let index = 0; index < operations.length - 1; index++) {
      if (!this.fold(operations[index]!, values)) return undefined;
    }
    return values.get(last.value) ?? this.expressionOf(last.value);
  }

  /** Local expression for one pure scalar operation; operands fall back to emitted values. */
  private fold(operation: OperationIR, values: Map<number, string>): boolean {
    if (!('result' in operation) || !('type' in operation)) return false;
    if (operation.type.kind !== 'number' && operation.type.kind !== 'bool') return false;
    const operand = (id: number): string | undefined => values.get(id) ?? this.expressionOf(id);
    switch (operation.kind) {
      case 'constant': {
        if (operation.constant.kind !== 'number' && operation.constant.kind !== 'bool')
          return false;
        if (operation.constant.kind === 'bool') this.booleanResults.add(operation.result);
        values.set(operation.result, this.literal(operation.constant.value));
        return true;
      }
      case 'read': {
        if (operation.resource !== 'state') return false;
        values.set(operation.result, `S[${this.state(operation.name, false)}]`);
        return true;
      }
      case 'localRead': {
        const slot = this.locals.get(operation.local);
        if (!slot) return false;
        values.set(operation.result, slot);
        return true;
      }
      case 'unary': {
        const operator = unary[operation.operator];
        const value = operand(operation.value);
        if (!operator || value === undefined) return false;
        if (operation.operator === 'not') this.booleanResults.add(operation.result);
        values.set(operation.result, `(${operator}${value})`);
        return true;
      }
      case 'binary': {
        const operator = binary[operation.operator];
        const left = operand(operation.left);
        const right = operand(operation.right);
        if (!operator || left === undefined || right === undefined) return false;
        if (comparisons.has(operation.operator)) this.booleanResults.add(operation.result);
        values.set(operation.result, `(${left} ${operator} ${right})`);
        return true;
      }
      case 'numeric': {
        if (!numeric.has(operation.builtin)) return false;
        const args: string[] = [];
        for (const id of operation.args) {
          const value = operand(id);
          if (value === undefined) return false;
          args.push(value);
        }
        if (predicates.has(operation.builtin)) this.booleanResults.add(operation.result);
        const owner = predicates.has(operation.builtin) ? 'Number' : 'Math';
        values.set(operation.result, `${owner}.${operation.builtin}(${args.join(',')})`);
        return true;
      }
      case 'nonNull': {
        const value = operand(operation.value);
        if (value === undefined) return false;
        values.set(operation.result, `H.nonNull(${value})`);
        return true;
      }
      default:
        return false;
    }
  }

  /** Host-based operations require the runtime to have supplied a frame host. */
  private requireHost(): void {
    if (this.binding.host !== true) throw unsupported;
  }

  /** Assertion messages admit only a string constant region, so they stay compile-time data. */
  private message(region: ValueRegionIR): string {
    const operations = region.body.operations;
    const constant = operations[0];
    const delivered = operations[1];
    if (
      operations.length !== 2 ||
      constant?.kind !== 'constant' ||
      constant.constant.kind !== 'string' ||
      delivered?.kind !== 'yield' ||
      delivered.value !== constant.result
    )
      throw unsupported;
    return this.literal(constant.constant.value);
  }

  /** Match constants: validated numbers/booleans inline, names and strings stay data. */
  private pattern(pattern: MatchPatternIR): string {
    switch (pattern.kind) {
      case 'none':
        return 'null';
      case 'number':
      case 'bool':
        return this.literal(pattern.value);
      case 'string':
        return this.literal(pattern.value);
      case 'enum':
        return this.literal(pattern.member);
    }
  }

  private region(
    region: RegionIR,
    lines: string[],
    output?: { slot: string; label: string },
  ): void {
    let exited = false;
    for (const operation of region.operations) {
      // Anything after a branch-level redirect on the same path is unreachable.
      if (exited) throw unsupported;
      if (operation.kind === 'yield') {
        if (!output) throw unsupported;
        lines.push(`${output.slot} = ${this.value(operation.value)}; break ${output.label};`);
      } else if (operation.kind === 'redirect') {
        // A conditional exit belongs to the labeled body installed by compileConditional.
        // Value regions cannot break to it, and a linear body has no label at all.
        if (output !== undefined || this.exitLabel === undefined || this.exitDuration === undefined)
          throw unsupported;
        const delay = this.delay(operation.delay);
        lines.push(
          `S[${this.binding.pc.index}] = H.checkPc(${this.value(operation.target)});`,
          dirty('SD', this.binding.pc.index),
          `${this.exitDuration} = ${delay.value};`,
          `break ${this.exitLabel};`,
        );
        exited = true;
      } else {
        this.operation(operation, lines, output);
      }
    }
  }

  private operation(
    operation: OperationIR,
    lines: string[],
    output?: { slot: string; label: string },
  ): void {
    let result: string | undefined;
    if (hosted.has(operation.kind)) this.requireHost();
    if ('result' in operation) {
      const kind = operation.type.kind;
      if (kind !== 'number' && kind !== 'bool') {
        const allowed =
          wideResults.has(operation.kind) ||
          (operation.kind === 'constant' &&
            (kind === 'string' || kind === 'enum' || kind === 'bytes'));
        if (!allowed) throw unsupported;
      }
      // A folded value needs no slot: folding is what removes host statements per IR op.
      if (this.foldResult(operation)) return;
      result = this.slot();
      this.values.set(operation.result, result);
      if (referenceResults.has(kind)) this.references.add(operation.result);
    }
    const assign = (expression: string): void => {
      lines.push(`${result!} = ${expression};`);
    };
    switch (operation.kind) {
      case 'parameter':
        if (!this.fn?.params[operation.index]) throw unsupported;
        assign(`a${operation.index}`);
        break;
      case 'return':
      case 'returnValue':
        if (!this.fn) throw unsupported;
        lines.push(
          operation.kind === 'returnValue' ? `return ${this.value(operation.value)};` : 'return;',
        );
        break;
      case 'call':
      case 'callValue': {
        const compiled = this.resolveFunction?.(operation.name);
        if (!compiled) throw unsupported;
        const args = operation.args.map((arg) => {
          if (arg.kind !== 'value') throw unsupported;
          return this.value(arg.value);
        });
        // The helper sees the same state/memory banks and dirty bits. Its effects must also
        // participate in the caller's observer barrier before any part of the instruction runs.
        for (const name of compiled.body.readStates) this.state(name, false);
        for (const name of compiled.body.writeStates) this.state(name, true);
        for (const name of compiled.body.readMemories)
          this.memory({ kind: 'load8', memory: { kind: 'memory', name } });
        for (const name of compiled.body.writeMemories)
          this.memory({ kind: 'store8', memory: { kind: 'memory', name } });
        const call = `${compiled.target}(F${args.map((arg) => `, ${arg}`).join('')})`;
        if (operation.kind === 'callValue') assign(call);
        else lines.push(`${call};`);
        break;
      }
      case 'constant': {
        // Numbers, booleans, strings and enum members folded above; only a byte literal still
        // materialises a fresh value at every evaluation.
        if (operation.constant.kind !== 'bytes') throw unsupported;
        // The generic host materialises the literal when it compiles the body, so an
        // out-of-range element declines compilation here and keeps that same error.
        let bytes: readonly number[];
        try {
          bytes = Object.freeze(Array.from(createBytes(operation.constant.value)));
        } catch {
          throw unsupported;
        }
        // Every evaluation still gets a fresh Uint8Array, exactly like `H.createBytes`.
        assign(`H.createBytes(${this.capture(bytes)})`);
        break;
      }
      case 'read':
        if (operation.resource !== 'state') throw unsupported;
        assign(`S[${this.state(operation.name, false)}]`);
        break;
      case 'write': {
        const index = this.state(operation.name, true);
        const word = index >>> 5;
        const mask = (1 << (index & 31)) >>> 0;
        lines.push(
          `S[${index}] = ${this.value(operation.value)};`,
          dirty('SD', index),
          `if (BS[${word}] & ${mask}) F.publishPending = true;`,
        );
        break;
      }
      case 'unary': {
        const operator = unary[operation.operator];
        if (!operator) throw unsupported;
        assign(`(${operator}${this.value(operation.value)})`);
        if (operation.operator === 'not') this.booleanResults.add(operation.result);
        break;
      }
      case 'binary': {
        const operator = binary[operation.operator];
        if (!operator) throw unsupported;
        const left = this.value(operation.left);
        const right = this.value(operation.right);
        if (comparisons.has(operation.operator)) this.booleanResults.add(operation.result);
        // Byte sequences and intents compare by content in the generic host; `===` would
        // compare identity and silently change the result.
        if (
          (operation.operator === 'equal' || operation.operator === 'notEqual') &&
          (this.references.has(operation.left) || this.references.has(operation.right))
        ) {
          assign(`${operation.operator === 'notEqual' ? '!' : ''}H.equalValues(${left},${right})`);
          break;
        }
        assign(`(${left} ${operator} ${right})`);
        break;
      }
      case 'numeric':
        if (!numeric.has(operation.builtin)) throw unsupported;
        if (predicates.has(operation.builtin)) this.booleanResults.add(operation.result);
        assign(
          `${predicates.has(operation.builtin) ? 'Number' : 'Math'}.${operation.builtin}(${operation.args.map((id) => this.value(id)).join(',')})`,
        );
        break;
      case 'send':
        lines.push(
          `F.host.send(${this.capture(operation.channel)}, ${this.value(operation.value)});`,
        );
        break;
      case 'notify':
        lines.push(`F.host.notify(${this.capture(operation.notification)});`);
        break;
      case 'readSample': {
        if (operation.pin.kind !== 'pin') throw unsupported;
        const pinIndex = this.binding.pins?.get(operation.pin.name);
        if (validIndex(pinIndex)) {
          assign(`P[${pinIndex}].sample`);
          break;
        }
        assign(`F.host.sample(${this.capture(operation.pin.name)})`);
        break;
      }
      case 'writeIntent': {
        if (operation.pin.kind !== 'pin') throw unsupported;
        const pinIndex = this.binding.pins?.get(operation.pin.name);
        if (validIndex(pinIndex)) {
          lines.push(`F.writePinIntent(${pinIndex}, ${this.value(operation.value)});`);
          break;
        }
        lines.push(
          `F.host.intent(${this.capture(operation.pin.name)}, ${this.value(operation.value)});`,
        );
        break;
      }
      case 'resistor': {
        if (operation.to.kind !== 'pin') throw unsupported;
        const pinIndex = this.binding.pins?.get(operation.to.name);
        const folded = this.folded.get(operation.resistance);
        if (
          validIndex(pinIndex) &&
          this.resistorSlot !== undefined &&
          folded !== undefined &&
          typeof folded.value === 'number' &&
          Number.isFinite(folded.value) &&
          folded.value >= 0.001 &&
          folded.value <= 1_000_000_000
        ) {
          const rSlot = this.resistorSlot(operation.to.name, folded.value);
          assign(
            `(R[${rSlot}] ?? (R[${rSlot}] = F.host.resistor(${this.capture(operation.to.name)}, ${folded.text})))`,
          );
          break;
        }
        assign(
          `F.host.resistor(${this.capture(operation.to.name)}, ${this.value(operation.resistance)})`,
        );
        break;
      }
      case 'combineIntents':
        assign(`H.combineIntents([${operation.values.map((id) => this.value(id)).join(',')}])`);
        break;
      case 'field':
        if (this.binding.pins !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(operation.field)) {
          assign(`${this.value(operation.value)}.${operation.field}`);
          break;
        }
        assign(`${this.value(operation.value)}[${this.capture(operation.field)}]`);
        break;
      case 'bytes':
        assign(`H.createBytes([${operation.elements.map((id) => this.value(id)).join(',')}])`);
        break;
      case 'index':
        assign(`H.readIndex(${this.value(operation.value)},${this.value(operation.index)})`);
        break;
      case 'refEqual':
        if (operation.left.kind === 'parameter' || operation.right.kind === 'parameter')
          throw unsupported;
        this.booleanResults.add(operation.result);
        assign(operation.left.name === operation.right.name ? 'true' : 'false');
        break;
      case 'length':
        assign(`${this.value(operation.value)}.length`);
        break;
      case 'optional':
        assign(this.value(operation.value));
        break;
      case 'isNone':
        this.booleanResults.add(operation.result);
        assign(`(${this.value(operation.value)} === null)`);
        break;
      case 'nonNull':
        assign(`H.nonNull(${this.value(operation.value)})`);
        break;
      case 'now':
        // The frame clock already holds this board time; host.now() would lag it.
        assign('F.time');
        break;
      case 'random':
        assign('F.host.random()');
        break;
      case 'assert': {
        const message =
          operation.message === undefined ? 'undefined' : this.message(operation.message);
        lines.push(
          `if (!${this.condition(operation.condition)}) F.host.assert(false, ${message});`,
        );
        break;
      }
      case 'local': {
        if (operation.type.kind !== 'number' && operation.type.kind !== 'bool') throw unsupported;
        const slot = this.slot();
        this.locals.set(operation.local, slot);
        lines.push(`${slot} = ${this.value(operation.initial)};`);
        break;
      }
      case 'localRead': {
        const slot = this.locals.get(operation.local);
        if (!slot) throw unsupported;
        assign(slot);
        break;
      }
      case 'localWrite': {
        const slot = this.locals.get(operation.local);
        if (!slot) throw unsupported;
        lines.push(`${slot} = ${this.value(operation.value)};`);
        break;
      }
      case 'load8': {
        const memory = `M[${this.memory(operation)}]`;
        const foldedOffset = this.folded.get(operation.offset);
        if (
          foldedOffset !== undefined &&
          typeof foldedOffset.value === 'number' &&
          Number.isSafeInteger(foldedOffset.value) &&
          foldedOffset.value >= 0
        ) {
          assign(
            `(${foldedOffset.text} < ${memory}.length ? ${memory}[${foldedOffset.text}] : H.offset(${memory},${foldedOffset.text}))`,
          );
          break;
        }
        assign(`${memory}[H.offset(${memory},${this.value(operation.offset)})]`);
        break;
      }
      case 'store8': {
        const index = this.memory(operation);
        const memory = `M[${index}]`;
        // Check the address before the value, as the generic host does.
        lines.push(
          `${memory}[H.offset(${memory},${this.value(operation.offset)})] = H.byte(${this.value(operation.value)});`,
          dirty('MD', index),
          `if (BM[${index >>> 5}] & ${(1 << (index & 31)) >>> 0}) F.publishPending = true;`,
        );
        break;
      }
      case 'load16le':
      case 'load16be': {
        const index = this.memory(operation);
        const memory = `M[${index}]`;
        const little = operation.kind.endsWith('le') ? 'true' : 'false';
        assign(`H.load16(${memory},MV[${index}],${this.value(operation.offset)},${little})`);
        break;
      }
      case 'load32le':
      case 'load32be': {
        const index = this.memory(operation);
        const memory = `M[${index}]`;
        const little = operation.kind.endsWith('le') ? 'true' : 'false';
        assign(`H.load32(${memory},MV[${index}],${this.value(operation.offset)},${little})`);
        break;
      }
      case 'store16le':
      case 'store16be':
      case 'store32le':
      case 'store32be': {
        const index = this.memory(operation);
        const memory = `M[${index}]`;
        const store = operation.kind.startsWith('store16') ? 'store16' : 'store32';
        const little = operation.kind.endsWith('le') ? 'true' : 'false';
        // Address validation precedes the stored-value check inside the helper.
        lines.push(
          `H.${store}(${memory},MV[${index}],${this.value(operation.offset)},${this.value(operation.value)},${little});`,
          dirty('MD', index),
          `if (BM[${index >>> 5}] & ${(1 << (index & 31)) >>> 0}) F.publishPending = true;`,
        );
        break;
      }
      case 'and':
      case 'or': {
        if (operation.right.body.operations.at(-1)?.kind !== 'yield') throw unsupported;
        this.booleanResults.add(operation.result);
        const label = `${operation.kind}${this.labels++}`;
        lines.push(
          `${result} = ${this.condition(operation.left)};`,
          `${operation.kind === 'or' ? 'if (!' : 'if ('}${result}) {`,
          `${label}: {`,
        );
        this.region(operation.right.body, lines, { slot: result!, label });
        lines.push('}', `${result} = ${guard(result!)};`, '}');
        break;
      }
      case 'match': {
        const value = this.value(operation.value);
        if (!operation.arms.length && !operation.otherwise) throw unsupported;
        // Without an else arm a value-position match could leave its output unassigned.
        if (!operation.otherwise && output) throw unsupported;
        operation.arms.forEach((arm, index) => {
          const pattern = this.pattern(arm.pattern);
          lines.push(`${index ? '} else if' : 'if'} (H.equalValues(${value}, ${pattern})) {`);
          this.region(arm.body, lines, output);
        });
        if (operation.otherwise) {
          lines.push(operation.arms.length ? '} else {' : '{');
          this.region(operation.otherwise, lines, output);
        }
        lines.push('}');
        break;
      }
      case 'if': {
        lines.push(`if (${this.condition(operation.condition)}) {`);
        const yesStart = lines.length;
        this.region(operation.yes, lines, output);
        if (operation.no) {
          const yesLength = lines.length - yesStart;
          lines.push('} else {');
          const noStart = lines.length;
          this.region(operation.no, lines, output);
          const noLength = lines.length - noStart;
          // Statement-position arms cannot yield to an enclosing label, and the
          // region emitter declines suspension and instruction-level exits.
          // Compaction rewrites each line in place, so these boundaries stay valid.
          if (
            !output &&
            lines === this.prefix &&
            yesLength > 0 &&
            noLength >= OUTLINE_MIN_LINES &&
            noLength >= yesLength * OUTLINE_MIN_RATIO
          )
            (this.outlineBranches ??= []).push({ start: noStart, end: lines.length });
        }
        lines.push('}');
        break;
      }
      case 'while': {
        // Initially keep loops in statement position. A body cannot suspend, yield a
        // value, or transfer control: the normal region emitter declines those shapes.
        if (output || operation.test.body.operations.at(-1)?.kind !== 'yield') throw unsupported;
        const head = lines.length;
        const condition = this.slot();
        const label = `loopTest${this.labels++}`;
        lines.push('while (true) {', `${label}: {`);
        this.region(operation.test.body, lines, { slot: condition, label });
        lines.push('}', `if (!${guard(condition)}) break;`);
        this.region(operation.body, lines);
        (this.backedges ??= []).push({ lines, head, tail: lines.length });
        lines.push('}');
        break;
      }
      case 'select': {
        const condition = this.condition(operation.condition);
        const yes = this.expression(operation.yes);
        const no = yes === undefined ? undefined : this.expression(operation.no);
        const markBoolean = (): void => {
          if (operation.type.kind !== 'bool') return;
          const yesLast = operation.yes.body.operations.at(-1);
          const noLast = operation.no.body.operations.at(-1);
          if (
            yesLast?.kind === 'yield' &&
            noLast?.kind === 'yield' &&
            this.isGuaranteedBoolean(yesLast.value) &&
            this.isGuaranteedBoolean(noLast.value)
          ) {
            this.booleanResults.add(operation.result);
          }
        };
        if (yes !== undefined && no !== undefined) {
          lines.push(`${result} = ${condition} ? ${yes} : ${no};`);
          markBoolean();
          break;
        }
        const label = `select${this.labels++}`;
        lines.push(`${label}: {`, `if (${condition}) {`);
        this.region(operation.yes.body, lines, { slot: result!, label });
        lines.push('} else {');
        this.region(operation.no.body, lines, { slot: result!, label });
        lines.push('}', '}');
        markBoolean();
        break;
      }
      default:
        throw unsupported;
    }
  }
}

/** One instruction record staged by an incremental commit. */
interface StagedChange {
  readonly pc: number;
  /** Non-finite `nextPc` removes the cache record instead of adding one. */
  readonly remove: boolean;
  readonly record: CachedInstruction | undefined;
  /** True when the instruction body was emitted or the cached record was rebuilt. */
  readonly changed: boolean;
  /** True when only the share marker changed and the compiled body was reused. */
  readonly metadataOnly: boolean;
}

interface SessionCounters {
  batches: number;
  routeInstalls: number;
  routeRemovals: number;
  compiledShards: number;
  reusedShards: number;
  compiledBlocks: number;
  reusedBlocks: number;
  invalidatedBlocks: number;
  bodyBytes: number;
  shardBytes: number;
  dispatcherBytes: number;
  helperBytes: number;
  sharedBodies: number;
  sharedBytes: number;
  shareReusedBodies: number;
  shareReusedRoutes: number;
}

/** Delay maps are not part of the binding fingerprint: entries carry their own snapshots. */
function bindingWithDelays(
  binding: DirectJitBinding,
  delays: ReadonlyMap<number, DirectJitDelay> | undefined,
): DirectJitBinding {
  const rest = { ...binding };
  delete rest.delayLoops;
  return delays === undefined ? rest : { ...rest, delayLoops: delays };
}

function sessionShardSize(binding: DirectJitBinding): number {
  const size = binding.shardSize;
  return validIndex(size) && size > 0 ? size : DIRECT_SHARD_SIZE;
}

/**
 * Fixed dispatcher shared by every revision of one session. Routes, continuations and status
 * sets are mutable maps/sets captured by the generated function, so a new instruction only
 * changes lookups; the generated source and its shape never change after creation.
 */
type SessionDispatcher = (frame: DirectJitFrame, deadline: number) => DirectJitRunResult;
type SessionDispatcherFactory = (
  routes: ReadonlyMap<number, SessionRoute>,
  resumes: ReadonlyMap<number, ResidentResume>,
  rejected: ReadonlySet<number>,
  isolated: ReadonlySet<number>,
  runtimeHelpers: typeof helpers,
) => SessionDispatcher;

class DirectJitSessionImpl implements DirectJitSession {
  private readonly routes = new Map<number, SessionRoute>();
  private readonly resumes = new Map<number, ResidentResume>();
  private readonly rejected = new Set<number>();
  private readonly isolated = new Set<number>();
  private readonly owners = new Map<number, ResidentShard>();
  /** Shared bodies and their live route membership, reclassified only on commits. */
  private readonly sharedVariants: SharedVariant[] = [];
  private readonly sharedRoutes = new Map<number, SharedRoute>();
  private readonly shareStates = new Map<number, ShareCategory>();
  private readonly shareRejected: { -readonly [K in keyof DirectJitShareRejectedStats]: number } = {
    missing: 0,
    invalid: 0,
    single: 0,
    ir: 0,
    delay: 0,
    isolated: 0,
    context: 0,
  };
  private nextSharedVariant = 1;
  private readonly counters: SessionCounters = {
    batches: 0,
    routeInstalls: 0,
    routeRemovals: 0,
    compiledShards: 0,
    reusedShards: 0,
    compiledBlocks: 0,
    reusedBlocks: 0,
    invalidatedBlocks: 0,
    bodyBytes: 0,
    shardBytes: 0,
    dispatcherBytes: 0,
    helperBytes: 0,
    sharedBodies: 0,
    sharedBytes: 0,
    shareReusedBodies: 0,
    shareReusedRoutes: 0,
  };
  private delays: ReadonlyMap<number, DirectJitDelay> | undefined;
  private compileBinding: DirectJitBinding;
  private localSlots = 0;
  private sessionPcs: readonly number[] = Object.freeze([]);
  private closed = false;
  private readonly runFunction: SessionDispatcher;

  constructor(
    private readonly cache: DirectJitCache,
    private readonly state: DirectJitCacheState,
    private readonly binding: DirectJitBinding,
    private readonly fingerprint: BindingFingerprint,
  ) {
    this.delays = binding.delayLoops;
    this.compileBinding = bindingWithDelays(binding, this.delays);
    this.runFunction = this.createDispatcher();
    const helperBefore = this.state.helperBytes;
    // A cache may have been populated by full builds under another delay map. Their bodies
    // carry a delay snapshot, so reconcile it before the first shard adopts the entries.
    const initial = this.reconcileDelays(this.delays);
    if (initial.size) {
      this.applyEntryChanges(initial);
      this.counters.helperBytes += this.state.helperBytes - helperBefore;
    }
    this.rebuildAll();
  }

  get sessionFingerprint(): BindingFingerprint {
    return this.fingerprint;
  }

  get isDisposed(): boolean {
    return this.closed;
  }

  get localCount(): number {
    return this.localSlots;
  }

  get shardCount(): number {
    return this.closed ? 0 : this.state.shards.length;
  }

  get routeCount(): number {
    return this.routes.size;
  }

  get pcs(): readonly number[] {
    return this.sessionPcs;
  }

  has(pc: number): boolean {
    return !this.closed && this.routes.has(pc);
  }

  run(frame: DirectJitFrame, deadline: number): DirectJitRunResult {
    if (this.closed) return 'untranslated';
    return this.runFunction(frame, deadline);
  }

  add(instructions: readonly DirectJitInstruction[]): void {
    this.assertActive();
    const helperBefore = this.state.helperBytes;
    const seen = new Set<number>();
    const staged = new Map<number, StagedChange>();
    let sharingTouched = false;
    for (const instruction of instructions) {
      if (!Number.isFinite(instruction.pc) || seen.has(instruction.pc)) continue;
      seen.add(instruction.pc);
      const cached = this.state.entries.get(instruction.pc);
      if (cached !== undefined && (cached.share !== undefined || cached.shareInvalid))
        sharingTouched = true;
      if (!Number.isFinite(instruction.nextPc)) {
        // The first occurrence of a PC owns it even when that occurrence deletes the entry.
        staged.set(instruction.pc, {
          pc: instruction.pc,
          remove: true,
          record: undefined,
          changed: true,
          metadataOnly: false,
        });
        continue;
      }
      const delay = delayFingerprint(this.delays?.get(instruction.pc));
      const marker = readShare(instruction.share);
      if (instruction.share !== undefined || marker.invalid) sharingTouched = true;
      if (
        cached !== undefined &&
        cached.body === instruction.body &&
        cached.nextPc === instruction.nextPc &&
        sameDelay(cached.delay, delay)
      ) {
        const compiled = cached.instruction;
        if (compiled !== undefined) compiled.resumeId = cached.resumeId ?? 0;
        if (sameShare(cached.share, marker.share) && cached.shareInvalid === marker.invalid) {
          staged.set(instruction.pc, {
            pc: instruction.pc,
            remove: false,
            record: cached,
            changed: false,
            metadataOnly: false,
          });
        } else if (cached.share !== undefined) {
          // Leaving a shared group must not expose the old normal continuation id again:
          // a suspended frame keeps its old function, and the independent route gets a new id.
          staged.set(instruction.pc, {
            pc: instruction.pc,
            remove: false,
            record: this.compileRecord(instruction, delay, marker),
            changed: true,
            metadataOnly: false,
          });
        } else {
          sharingTouched = true;
          staged.set(instruction.pc, {
            pc: instruction.pc,
            remove: false,
            record: { ...cached, share: marker.share, shareInvalid: marker.invalid },
            changed: false,
            metadataOnly: true,
          });
        }
        continue;
      }
      staged.set(instruction.pc, {
        pc: instruction.pc,
        remove: false,
        record: this.compileRecord(instruction, delay, marker),
        changed: true,
        metadataOnly: false,
      });
    }
    if (!staged.size) {
      this.counters.batches++;
      return;
    }
    // Entry and shard commits happen only after every body compiled; a non-`unsupported`
    // exception therefore leaves the previous route table intact.
    this.commitChanges(staged, sharingTouched);
    this.counters.helperBytes += this.state.helperBytes - helperBefore;
    this.counters.batches++;
  }

  remove(pcs: readonly number[]): void {
    this.assertActive();
    const seen = new Set<number>();
    const staged = new Map<number, StagedChange>();
    for (const pc of pcs) {
      if (!Number.isFinite(pc) || seen.has(pc)) continue;
      seen.add(pc);
      if (!this.state.entries.has(pc)) continue;
      staged.set(pc, {
        pc,
        remove: true,
        record: undefined,
        changed: true,
        metadataOnly: false,
      });
    }
    if (!staged.size) return;
    this.commitChanges(staged, false);
  }

  updateDelays(delays?: ReadonlyMap<number, DirectJitDelay>): void {
    this.assertActive();
    const effective = delays ?? this.binding.delayLoops;
    this.delays = effective;
    this.compileBinding = bindingWithDelays(this.binding, effective);
    const helperBefore = this.state.helperBytes;
    const staged = this.reconcileDelays(effective);
    if (!staged.size) return;
    this.commitChanges(staged, false);
    this.counters.helperBytes += this.state.helperBytes - helperBefore;
  }

  clear(): void {
    this.assertActive();
    this.counters.routeRemovals += this.routes.size;
    this.routes.clear();
    this.resumes.clear();
    this.rejected.clear();
    this.isolated.clear();
    this.owners.clear();
    this.sharedVariants.length = 0;
    this.sharedRoutes.clear();
    this.shareStates.clear();
    this.nextSharedVariant = 1;
    this.state.entries.clear();
    this.state.constants.length = 0;
    this.state.resistorSlots.clear();
    this.state.functions.clear();
    this.state.shards.length = 0;
    this.state.nextShard = 1;
    // `nextResume` intentionally keeps growing: a suspended frame must never observe a
    // reused identifier pointing at a different body after a clear.
    this.state.stats.clears++;
    this.refreshPcs();
  }

  stats(): DirectJitSessionStats {
    let candidates = 0;
    for (const record of this.state.entries.values()) if (record.share !== undefined) candidates++;
    let groups = 0;
    for (const variant of this.sharedVariants)
      if (variant.functions !== undefined && variant.entries.size > 0) groups++;
    return Object.freeze({
      batches: this.counters.batches,
      routeInstalls: this.counters.routeInstalls,
      routeRemovals: this.counters.routeRemovals,
      compiledShards: this.counters.compiledShards,
      reusedShards: this.counters.reusedShards,
      compiledBlocks: this.counters.compiledBlocks,
      reusedBlocks: this.counters.reusedBlocks,
      invalidatedBlocks: this.counters.invalidatedBlocks,
      routes: this.routes.size,
      shards: this.closed ? 0 : this.state.shards.length,
      bodyBytes: this.counters.bodyBytes,
      shardBytes: this.counters.shardBytes,
      dispatcherBytes: this.counters.dispatcherBytes,
      helperBytes: this.counters.helperBytes,
      shareCandidates: this.closed ? 0 : candidates,
      shareGroups: groups,
      sharedRoutes: this.sharedRoutes.size,
      shareReusedBodies: this.counters.shareReusedBodies,
      shareReusedRoutes: this.counters.shareReusedRoutes,
      shareRejected: Object.freeze({ ...this.shareRejected }),
      sharedBodies: this.counters.sharedBodies,
      sharedBytes: this.counters.sharedBytes,
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.routes.clear();
    this.resumes.clear();
    this.rejected.clear();
    this.isolated.clear();
    this.owners.clear();
    this.sharedVariants.length = 0;
    this.sharedRoutes.clear();
    this.shareStates.clear();
    this.refreshPcs();
    if (directJitSessions.get(this.cache) === this) directJitSessions.delete(this.cache);
  }

  private assertActive(): void {
    if (this.closed) throw new TypeError('Direct JIT session has been disposed');
  }

  private createDispatcher(): SessionDispatcher {
    const pcIndex = this.binding.pc.index;
    const source = [
      '"use strict";',
      'function run(F, deadline) {',
      'const S = F.states;',
      'if (F.time >= deadline) return "deadline";',
      'let pc;',
      'if (F.resume !== 0) {',
      'if (F.due >= deadline) { F.time = deadline; return "deadline"; }',
      'F.time = Math.max(F.time, F.due);',
      'const resume = F.resume;',
      'const resumed = RESUME.get(resume);',
      'if (resumed === undefined) throw new TypeError("Unknown direct JIT continuation");',
      'const next = resumed(F, resume);',
      'if (typeof next !== "number") return next;',
      'if (ISOLATED.has(next)) return "invalidated";',
      'pc = next;',
      '} else {',
      'if (F.stopAfterInstruction) return "invalidated";',
      `pc = S[${pcIndex}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc);`,
      '}',
      'while (true) {',
      'const route = ROUTES.get(pc);',
      'if (route === undefined) return REJECTED.has(pc) ? "fallback" : "untranslated";',
      'const next = typeof route === "function" ? route(F, deadline, pc) : route.step(F, deadline, route.nextPc);',
      'if (typeof next !== "number") return next;',
      'pc = next;',
      '}',
      '}',
      'return run;',
    ].join('\n');
    this.counters.dispatcherBytes = source.length;
    const factory = new Function(
      'ROUTES',
      'RESUME',
      'REJECTED',
      'ISOLATED',
      'H',
      source,
    ) as SessionDispatcherFactory;
    return factory(this.routes, this.resumes, this.rejected, this.isolated, helpers);
  }

  /** Recompile only entries whose counter/cycles/pending snapshot changed. */
  private reconcileDelays(
    delays: ReadonlyMap<number, DirectJitDelay> | undefined,
  ): Map<number, StagedChange> {
    const staged = new Map<number, StagedChange>();
    for (const [pc, cached] of this.state.entries) {
      const delay = delayFingerprint(delays?.get(pc));
      if (sameDelay(cached.delay, delay)) continue;
      const record = this.compileRecord({ pc, nextPc: cached.nextPc, body: cached.body }, delay, {
        share: cached.share,
        invalid: cached.shareInvalid,
      });
      staged.set(pc, {
        pc,
        remove: false,
        record,
        changed: true,
        metadataOnly: false,
      });
    }
    return staged;
  }

  private compileRecord(
    instruction: DirectJitInstruction,
    delay: DelayFingerprint | undefined,
    share: ShareStamp,
  ): CachedInstruction {
    const compiled = this.compileInstruction(instruction);
    // A recompiled body always receives a fresh continuation id. Reusing the previous id
    // would retarget frames suspended in the old body at the new suffix.
    let resumeId: number | undefined;
    if (compiled?.duration !== undefined) resumeId = this.state.nextResume++;
    if (compiled !== undefined) compiled.resumeId = resumeId ?? 0;
    return {
      body: instruction.body,
      nextPc: instruction.nextPc,
      delay,
      instruction: compiled,
      resumeId,
      share: share.share,
      shareInvalid: share.invalid,
    };
  }

  private compileInstruction(instruction: DirectJitInstruction): Instruction | undefined {
    const capture = (value: unknown): string => `C[${this.state.constants.push(value) - 1}]`;
    const resistorSlot = (pin: string, resistance: number): number => {
      const key = `${pin}\0${resistance}`;
      let slot = this.state.resistorSlots.get(key);
      if (slot === undefined) {
        slot = this.state.resistorSlots.size;
        this.state.resistorSlots.set(key, slot);
      }
      return slot;
    };
    const resolveFunction: ResolveFunction = (name) => this.resolveFunction(name, resistorSlot);
    try {
      return new Instruction(this.compileBinding, capture, resistorSlot, resolveFunction).compile(
        instruction,
      );
    } catch (error) {
      if (error !== unsupported) throw error;
      return undefined;
    }
  }

  private resolveFunction(
    name: string,
    resistorSlot: (pin: string, resistance: number) => number,
  ): ReturnType<ResolveFunction> {
    const cached = this.state.functions.get(name);
    if (cached === null) throw unsupported;
    if (cached !== undefined) return cached;
    // Reject cycles and missing callees before any caller body starts executing.
    this.state.functions.set(name, null);
    const fn = this.binding.functions?.get(name);
    if (fn === undefined) throw unsupported;
    const constants: unknown[] = [];
    const captureLocal = (value: unknown): string => `C[${constants.push(value) - 1}]`;
    const body = new Instruction(
      this.compileBinding,
      captureLocal,
      resistorSlot,
      (callee) => {
        const nested = this.resolveFunction(callee, resistorSlot);
        return { ...nested, target: captureLocal(nested.run) };
      },
      fn,
    );
    const run = body.compileFunction(constants);
    this.state.helperBytes += body.functionSourceSize;
    const capture = (value: unknown): string => `C[${this.state.constants.push(value) - 1}]`;
    const compiled = { target: capture(run), run, body };
    this.state.functions.set(name, compiled);
    return compiled;
  }

  private applyEntryChanges(staged: ReadonlyMap<number, StagedChange>): void {
    for (const change of staged.values()) {
      if (change.remove) {
        if (this.state.entries.delete(change.pc)) {
          this.state.stats.invalidatedBlocks++;
          this.counters.invalidatedBlocks++;
        }
        continue;
      }
      const record = change.record!;
      if (change.changed) {
        if (this.state.entries.has(change.pc)) {
          this.state.stats.invalidatedBlocks++;
          this.counters.invalidatedBlocks++;
        }
        this.state.entries.set(change.pc, record);
        this.state.stats.compiledBlocks++;
        this.counters.compiledBlocks++;
        if (record.instruction !== undefined) this.counters.bodyBytes += record.instruction.size;
      } else {
        this.state.stats.reusedBlocks++;
        this.counters.reusedBlocks++;
        if (change.metadataOnly) this.state.entries.set(change.pc, record);
      }
    }
  }

  private commitChanges(staged: ReadonlyMap<number, StagedChange>, sharingTouched: boolean): void {
    const sharing = sharingTouched || this.shareStates.size > 0 || this.sharedRoutes.size > 0;
    this.applyEntryChanges(staged);
    if (sharing) this.reconcileSharedLayout();
    else this.applyShardChanges(staged);
  }

  /**
   * Recompute equivalence groups over the current valid candidates. The comparison runs only
   * here, on `add`/`remove`/`updateDelays`, never in `run`. Existing variants are matched by
   * key, delay and structural IR so an equivalent body is emitted once for the lifetime of
   * the session; archived variants keep their resume identifiers for suspended frames.
   */
  private reconcileSharedLayout(): void {
    const assignment = new Map<
      number,
      { variant: SharedVariant | undefined; shared: boolean; category: ShareCategory }
    >();
    const valid = new Map<number, ShareKey>();
    const groups = new Map<string, ShareCandidateEntry[]>();

    for (const [pc, record] of this.state.entries) {
      if (record.share === undefined) continue;
      valid.set(pc, record.share);
      const instruction = record.instruction;
      if (instruction === undefined) {
        assignment.set(pc, { variant: undefined, shared: false, category: 'context' });
        continue;
      }
      if (instruction.isolated) {
        assignment.set(pc, { variant: undefined, shared: false, category: 'isolated' });
        continue;
      }
      const key = shareKeyText(record.share);
      let list = groups.get(key);
      if (list === undefined) {
        list = [];
        groups.set(key, list);
      }
      list.push({
        pc,
        nextPc: record.nextPc,
        record,
        instruction,
        share: record.share,
      });
    }

    for (const variant of this.sharedVariants) variant.entries = new Map();

    const emitted = new Set<SharedVariant>();
    for (const [key, list] of groups) {
      list.sort((left, right) => left.pc - right.pc);
      const partitions: ShareCandidateEntry[][] = [];
      for (const candidate of list) {
        let partition: ShareCandidateEntry[] | undefined;
        for (const current of partitions) {
          const representative = current[0]!;
          if (
            sameDelay(representative.record.delay, candidate.record.delay) &&
            sameRegion(representative.record.body, candidate.record.body)
          ) {
            partition = current;
            break;
          }
        }
        if (partition === undefined) partitions.push([candidate]);
        else partition.push(candidate);
      }
      for (const partition of partitions) {
        const representative = partition[0]!;
        let variant = this.sharedVariants.find(
          (existing) =>
            existing.key === key &&
            sameDelay(existing.delay, representative.record.delay) &&
            sameRegion(existing.body, representative.record.body),
        );
        if (variant === undefined) {
          variant = {
            id: this.nextSharedVariant++,
            key,
            share: representative.share,
            delay: representative.record.delay,
            body: representative.record.body,
            instruction: representative.instruction,
            functions: undefined,
            resumeId: 0,
            sourceSize: 0,
            entries: new Map(),
            attributed: new Set(),
          };
          this.sharedVariants.push(variant);
        }
        for (const candidate of partition) variant.entries.set(candidate.pc, candidate.nextPc);
        if (variant.functions === undefined && variant.entries.size >= 2) {
          this.compileSharedVariant(variant);
          emitted.add(variant);
        }
        for (const candidate of partition) {
          if (variant.functions !== undefined) {
            assignment.set(candidate.pc, { variant, shared: true, category: 'shared' });
            continue;
          }
          if (list.length === 1) {
            assignment.set(candidate.pc, {
              variant,
              shared: false,
              category: valid.size > 1 ? 'context' : 'single',
            });
            continue;
          }
          const sameDelayElsewhere = partitions.some(
            (other) =>
              other !== partition && sameDelay(other[0]!.record.delay, representative.record.delay),
          );
          assignment.set(candidate.pc, {
            variant,
            shared: false,
            category: sameDelayElsewhere ? 'ir' : 'delay',
          });
        }
      }
    }

    this.sharedRoutes.clear();
    for (const variant of this.sharedVariants) {
      const functions = variant.functions;
      if (functions === undefined || !variant.entries.size) continue;
      for (const [pc, nextPc] of variant.entries)
        this.sharedRoutes.set(pc, { step: functions.step, nextPc, variant });
    }

    for (const variant of this.sharedVariants) {
      if (variant.functions === undefined) {
        variant.attributed.clear();
        continue;
      }
      let reused = 0;
      for (const pc of variant.entries.keys()) if (!variant.attributed.has(pc)) reused++;
      if (emitted.has(variant)) reused = Math.max(0, reused - 1);
      this.counters.shareReusedBodies += reused;
      for (const pc of [...variant.attributed])
        if (!variant.entries.has(pc)) variant.attributed.delete(pc);
      for (const pc of variant.entries.keys()) variant.attributed.add(pc);
    }

    const nextStates = new Map<number, ShareCategory>();
    for (const [pc, record] of this.state.entries) {
      if (record.share !== undefined) {
        if (record.instruction === undefined) nextStates.set(pc, 'context');
        else if (record.instruction.isolated) nextStates.set(pc, 'isolated');
        else {
          const info = assignment.get(pc);
          if (info === undefined) nextStates.set(pc, 'single');
          else nextStates.set(pc, info.shared ? 'shared' : info.category);
        }
      } else if (record.shareInvalid) nextStates.set(pc, 'invalid');
      else if (this.shareStates.has(pc)) nextStates.set(pc, 'missing');
    }
    for (const [pc, state] of nextStates) {
      if (state === 'shared' || this.shareStates.get(pc) === state) continue;
      this.shareRejected[state]++;
    }
    this.shareStates.clear();
    for (const [pc, state] of nextStates) this.shareStates.set(pc, state);

    this.reconcileResidentLayout();
  }

  private compileSharedVariant(variant: SharedVariant): void {
    const instruction = variant.instruction;
    if (instruction.duration !== undefined) variant.resumeId = this.state.nextResume++;
    const lines = sharedBodyProgram(variant, this.compileBinding, this.binding.pc.index);
    const resume = instruction.duration === undefined ? 'undefined' : `resumeShared${variant.id}`;
    const source = `"use strict";\n${lines.join('\n')}\nreturn [stepShared${variant.id}, ${resume}];`;
    const factory = residentShardFactory(source);
    const [step, resumeFunction] = factory(Object.freeze([...this.state.constants]), helpers);
    variant.functions = { step, resume: resumeFunction };
    variant.sourceSize = source.length;
    this.counters.sharedBodies++;
    this.counters.sharedBytes += source.length;
  }

  /**
   * Reconcile shard ownership with the shared routes, then rebuild the desired route table
   * in place. Shards keep only independent entries; shared entries never occupy a shard.
   */
  private reconcileResidentLayout(): void {
    const entries: Instruction[] = [];
    for (const [pc, record] of this.state.entries) {
      const instruction = record.instruction;
      if (instruction !== undefined && !this.sharedRoutes.has(pc)) entries.push(instruction);
    }
    syncResidentShards(this.state, entries, this.shardSize, this.binding.pc.index);
    try {
      this.compileShards();
    } catch (error) {
      for (const shard of this.state.shards) shard.dirty = true;
      throw error;
    }

    const desired = new Map<number, SessionRoute>();
    const desiredIsolated = new Set<number>();
    const desiredRejected = new Set<number>();
    this.owners.clear();
    for (const shard of this.state.shards) {
      const functions = shard.functions;
      if (functions === undefined) continue;
      for (const entry of shard.entries) {
        this.owners.set(entry.pcValue, shard);
        desired.set(entry.pcValue, functions.step);
        if (entry.isolated) desiredIsolated.add(entry.pcValue);
        if (entry.resumeId !== 0 && functions.resume !== undefined)
          this.resumes.set(entry.resumeId, functions.resume);
      }
    }
    for (const [pc, route] of this.sharedRoutes) {
      desired.set(pc, route);
      const functions = route.variant.functions!;
      if (route.variant.resumeId !== 0 && functions.resume !== undefined)
        this.resumes.set(route.variant.resumeId, functions.resume);
    }
    for (const [pc, record] of this.state.entries)
      if (record.instruction === undefined) desiredRejected.add(pc);

    for (const pc of [...this.routes.keys()]) {
      if (desired.has(pc)) continue;
      this.routes.delete(pc);
      this.counters.routeRemovals++;
    }
    for (const [pc, route] of desired) {
      if (sameSessionRoute(this.routes.get(pc), route)) continue;
      this.routes.set(pc, route);
      this.counters.routeInstalls++;
      if (isSharedRoute(route)) this.counters.shareReusedRoutes++;
    }

    this.isolated.clear();
    for (const pc of desiredIsolated) this.isolated.add(pc);
    this.rejected.clear();
    for (const pc of desiredRejected) this.rejected.add(pc);
    for (const record of this.state.entries.values()) {
      const instruction = record.instruction;
      if (instruction !== undefined && instruction.slots.length > this.localSlots)
        this.localSlots = instruction.slots.length;
    }
    this.refreshPcs();
  }

  private applyShardChanges(staged: ReadonlyMap<number, StagedChange>): void {
    const pending: Instruction[] = [];
    const touched = new Set<ResidentShard>();
    for (const change of staged.values()) {
      const instruction = change.remove ? undefined : change.record!.instruction;
      const owner = this.owners.get(change.pc);
      if (owner !== undefined) {
        const index = owner.entries.findIndex((entry) => entry.pcValue === change.pc);
        if (index >= 0) {
          if (instruction === undefined) {
            owner.entries.splice(index, 1);
            owner.dirty = true;
            touched.add(owner);
          } else if (owner.entries[index] !== instruction) {
            owner.entries[index] = instruction;
            owner.dirty = true;
            touched.add(owner);
          }
          continue;
        }
        // The ownership index and the shard content disagreed; rebuild from the new entry.
        this.owners.delete(change.pc);
      }
      if (instruction !== undefined) pending.push(instruction);
    }
    for (const shard of touched) refreshShard(shard);
    for (let index = this.state.shards.length - 1; index >= 0; index--) {
      if (!this.state.shards[index]!.entries.length) this.state.shards.splice(index, 1);
    }
    this.appendPending(pending);
    let compiled: Set<ResidentShard>;
    try {
      compiled = this.compileShards();
    } catch (error) {
      // A failed factory may have replaced earlier shard functions before the route table
      // was touched. Keep those shards dirty so a retry recompiles and installs them too.
      for (const shard of this.state.shards) shard.dirty = true;
      throw error;
    }
    for (const shard of compiled) this.installShard(shard);
    for (const change of staged.values()) {
      const instruction = change.remove ? undefined : change.record!.instruction;
      if (instruction === undefined) {
        this.removeRoute(change.pc);
        if (change.remove) this.rejected.delete(change.pc);
        else this.rejected.add(change.pc);
        this.owners.delete(change.pc);
        continue;
      }
      this.rejected.delete(change.pc);
      if (instruction.slots.length > this.localSlots) this.localSlots = instruction.slots.length;
    }
    this.refreshPcs();
  }

  private appendPending(pending: Instruction[]): void {
    if (!pending.length) return;
    pending.sort((left, right) => left.pcValue - right.pcValue);
    const chains = buildEntryChains(pending, this.binding.pc.index);
    for (const chain of chains) {
      const chainSize = chain.reduce((sum, entry) => sum + entry.size, 0);
      const tail = this.state.shards[this.state.shards.length - 1];
      if (
        tail !== undefined &&
        tail.entries.length > 0 &&
        chain.length <= this.shardSize &&
        chainSize <= SHARD_CODE_BUDGET &&
        tail.sourceSize + chainSize > SHARD_CODE_BUDGET
      ) {
        this.newShard();
      }
      for (const entry of chain) {
        let shard = this.state.shards[this.state.shards.length - 1];
        if (shard === undefined || !shardCanAccept(shard, entry, this.shardSize)) {
          shard = this.newShard();
        }
        shard.entries.push(entry);
        shard.dirty = true;
        refreshShard(shard);
        this.owners.set(entry.pcValue, shard);
      }
    }
  }

  private newShard(): ResidentShard {
    const shard: ResidentShard = {
      id: this.state.nextShard++,
      entries: [],
      sourceSize: 0,
      maxSlots: 0,
      resumable: false,
      functions: undefined,
      signature: undefined,
      dirty: true,
    };
    this.state.shards.push(shard);
    return shard;
  }

  private compileShards(): Set<ResidentShard> {
    const compiled = new Set<ResidentShard>();
    for (const shard of this.state.shards) {
      if (
        shard.functions !== undefined &&
        !shard.dirty &&
        sameInstructions(shard.signature ?? [], shard.entries)
      ) {
        this.state.stats.reusedShards++;
        this.counters.reusedShards++;
        continue;
      }
      this.counters.shardBytes += compileResidentShard(this.state, shard, this.compileBinding);
      this.counters.compiledShards++;
      compiled.add(shard);
    }
    return compiled;
  }

  private installShard(shard: ResidentShard): void {
    const functions = shard.functions;
    if (functions === undefined) return;
    for (const entry of shard.entries) {
      this.owners.set(entry.pcValue, shard);
      if (this.routes.get(entry.pcValue) !== functions.step) {
        this.routes.set(entry.pcValue, functions.step);
        this.counters.routeInstalls++;
      }
      if (entry.resumeId !== 0 && functions.resume !== undefined)
        this.resumes.set(entry.resumeId, functions.resume);
      if (entry.isolated) this.isolated.add(entry.pcValue);
      else this.isolated.delete(entry.pcValue);
      this.rejected.delete(entry.pcValue);
    }
  }

  private removeRoute(pc: number): void {
    if (this.routes.delete(pc)) this.counters.routeRemovals++;
    this.isolated.delete(pc);
  }

  private rebuildAll(): void {
    let sharing = this.shareStates.size > 0 || this.sharedRoutes.size > 0;
    for (const record of this.state.entries.values()) {
      if (record.share !== undefined || record.shareInvalid) {
        sharing = true;
        break;
      }
    }
    if (sharing) {
      this.reconcileSharedLayout();
      return;
    }
    const entries: Instruction[] = [];
    for (const record of this.state.entries.values())
      if (record.instruction !== undefined) entries.push(record.instruction);
    syncResidentShards(this.state, entries, this.shardSize, this.binding.pc.index);
    this.compileShards();
    this.routes.clear();
    this.resumes.clear();
    this.rejected.clear();
    this.isolated.clear();
    this.owners.clear();
    for (const shard of this.state.shards) this.installShard(shard);
    for (const [pc, record] of this.state.entries)
      if (record.instruction === undefined) this.rejected.add(pc);
    this.localSlots = 0;
    for (const record of this.state.entries.values())
      if (record.instruction !== undefined && record.instruction.slots.length > this.localSlots)
        this.localSlots = record.instruction.slots.length;
    this.refreshPcs();
  }

  private refreshPcs(): void {
    this.sessionPcs = Object.freeze([...this.routes.keys()].sort((a, b) => a - b));
  }

  private get shardSize(): number {
    return sessionShardSize(this.binding);
  }
}

function createDirectJitSession(
  binding: DirectJitBinding,
  suppliedCache?: DirectJitCache,
): DirectJitSession {
  if (!validIndex(binding.pc.index) || binding.states.get(binding.pc.name) !== binding.pc.index)
    throw new TypeError('Invalid direct JIT binding');
  const cache = suppliedCache ?? createDirectJitCache();
  const state = cacheState(cache);
  const fingerprint = bindingFingerprint(binding);
  const existing = directJitSessions.get(cache);
  if (existing !== undefined) {
    if (!existing.isDisposed && sameBinding(existing.sessionFingerprint, fingerprint))
      return existing;
    existing.dispose();
  }
  if (state.binding !== undefined && !sameBinding(state.binding, fingerprint)) {
    // Slot indices are embedded in every emitted body; a layout change invalidates all of
    // them. Programs and disposed sessions keep their own frozen constant snapshots.
    state.stats.invalidatedBlocks += state.entries.size;
    state.entries.clear();
    state.constants.length = 0;
    state.resistorSlots.clear();
    state.functions.clear();
    state.shards.length = 0;
    state.nextResume = 1;
    state.nextShard = 1;
  }
  state.binding = fingerprint;
  const session = new DirectJitSessionImpl(cache, state, binding, fingerprint);
  directJitSessions.set(cache, session);
  return session;
}
