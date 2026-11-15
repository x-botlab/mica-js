import type {
  BinaryOperator,
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
  DirectJitProgram,
  DirectJitReason,
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

interface BindingFingerprint {
  readonly states: readonly (readonly [string, number])[];
  readonly memories: readonly (readonly [string, number])[];
  readonly pcName: string;
  readonly pcIndex: number;
  readonly host: boolean;
  readonly blockedStates: readonly string[] | undefined;
  readonly blockedMemories: readonly string[] | undefined;
}

interface CachedInstruction {
  readonly body: RegionIR;
  readonly nextPc: number;
  readonly delay: DelayFingerprint | undefined;
  readonly instruction: Instruction | undefined;
  /** Stable continuation ID once this body has ever emitted an elapse. */
  readonly resumeId: number | undefined;
}

type ResidentStatus = DirectJitReason | number;
type ResidentStep = (frame: DirectJitFrame, deadline: number, pc: number) => ResidentStatus;
type ResidentResume = (frame: DirectJitFrame, resume: number) => ResidentStatus;

interface ResidentFunctions {
  readonly step: ResidentStep;
  readonly resume: ResidentResume | undefined;
}

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
  readonly shards: ResidentShard[];
  nextResume: number;
  nextShard: number;
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

function createDirectJitCache(): DirectJitCache {
  const cache = Object.freeze({}) as unknown as DirectJitCache;
  directJitCaches.set(cache, {
    entries: new Map(),
    constants: [],
    shards: [],
    nextResume: 1,
    nextShard: 1,
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
    pcName: binding.pc.name,
    pcIndex: binding.pc.index,
    host: binding.host === true,
    blockedStates:
      binding.blockedStates === undefined ? undefined : [...binding.blockedStates].sort(),
    blockedMemories:
      binding.blockedMemories === undefined ? undefined : [...binding.blockedMemories].sort(),
  };
}

function samePairs(
  left: readonly (readonly [string, number])[],
  right: readonly (readonly [string, number])[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a[0] !== b[0] || a[1] !== b[1]) return false;
  }
  return true;
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
    samePairs(left.states, right.states) &&
    samePairs(left.memories, right.memories) &&
    sameNames(left.blockedStates, right.blockedStates) &&
    sameNames(left.blockedMemories, right.blockedMemories)
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

function clearCacheState(state: DirectJitCacheState): void {
  state.entries.clear();
  state.constants.length = 0;
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
  const state = cacheState(cache);
  const fingerprint = bindingFingerprint(binding);
  if (state.binding !== undefined && !sameBinding(state.binding, fingerprint)) {
    // Slot indices are embedded in every emitted body. A layout change invalidates all of
    // them, but old programs retain their own frozen constant table and stay self-contained.
    state.stats.invalidatedBlocks += state.entries.size;
    state.entries.clear();
    state.constants.length = 0;
    state.shards.length = 0;
    state.nextResume = 1;
    state.nextShard = 1;
  }
  state.binding = fingerprint;
  const capture = (value: unknown): string => `C[${state.constants.push(value) - 1}]`;
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
      state.stats.reusedBlocks++;
    } else {
      if (cached !== undefined) state.stats.invalidatedBlocks++;
      try {
        compiled = new Instruction(binding, capture).compile(instruction);
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
  const shardSize = validIndex(options.shardSize) && options.shardSize > 0 ? options.shardSize : 48;
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
  clearCache(cache: DirectJitCache): void {
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
  'const S = F.states, M = F.memories, L = F.locals, SD = F.stateDirty, MD = F.memoryDirty, MV = F.memoryViews ?? [];',
  'const BS = F.blockedStates ?? [], BM = F.blockedMemories ?? [];',
  ...(slots.length ? [`let ${slots.join(',')};`] : []),
];

/** One function holds the dispatcher, every continuation and every instruction body. */
function monolithicProgram(
  entries: readonly Instruction[],
  binding: DirectJitBinding,
  registers: readonly string[],
): string[] {
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
    lines.push('F.resume = 0;', ...entry.suffix, finish(entry.stop), '}');
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
    lines.push(...entry.suffix, finish(entry.stop), '}');
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
        stepFinish(entry.stop, lower, shard.lastPc, binding.pc.index),
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
      lines.push('F.resume = 0;', ...entry.suffix, splitFinish(entry.stop), '}');
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

/** Distance from an entry to the closest PC already resident in a shard. */
function shardDistance(shard: ResidentShard, entry: Instruction): number {
  let closest = Infinity;
  for (const resident of shard.entries)
    closest = Math.min(closest, Math.abs(resident.pcValue - entry.pcValue));
  return closest;
}

/** Prefer the nearest shard, then the least populated one to backfill sparse fragments. */
function closestAcceptingShard(
  shards: readonly ResidentShard[],
  entry: Instruction,
  shardSize: number,
): ResidentShard | undefined {
  let selected: ResidentShard | undefined;
  let selectedDistance = Infinity;
  for (const shard of shards) {
    if (!shardCanAccept(shard, entry, shardSize)) continue;
    const distance = shardDistance(shard, entry);
    if (
      distance < selectedDistance ||
      (distance === selectedDistance &&
        (selected === undefined || shard.entries.length < selected.entries.length))
    ) {
      selected = shard;
      selectedDistance = distance;
    }
  }
  return selected;
}

/**
 * Reconcile resident shard generations with the current compiled instruction set. Any shard
 * with capacity can absorb a later nearby block, so out-of-order translation can backfill the
 * fragments it left behind. Only touched shards recompile; unchanged functions stay reusable.
 */
function syncResidentShards(
  state: DirectJitCacheState,
  entries: readonly Instruction[],
  shardSize: number,
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
  for (const entry of pending) {
    let shard = closestAcceptingShard(state.shards, entry, shardSize);
    if (shard === undefined) {
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

/** Shortest safe membership fast path for the sorted entries of one resident shard. */
function residentPcSpan(entries: readonly Instruction[]): string {
  const first = entries[0]!;
  if (entries.length === 1) return `pc === ${first.pc}`;
  const last = entries[entries.length - 1]!;
  // Every entry lies in this span. Gaps safely reach the shard switch default, which returns
  // the PC to the dispatcher, so two bounds are shorter than enumerating sparse cases.
  return `pc >= ${first.pc} && pc <= ${last.pc}`;
}

function residentStepFinish(stop: boolean, inside: string, pcIndex: number): string {
  if (stop) return 'return "stopped";';
  return `if (F.stopAfterInstruction || F.publishPending) return "invalidated"; pc = S[${pcIndex}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc); if (${inside}) continue; return pc;`;
}

function residentResumeFinish(stop: boolean, pcIndex: number): string {
  if (stop) return 'return "stopped";';
  return `if (F.stopAfterInstruction || F.publishPending) return "invalidated"; const pc = S[${pcIndex}]; if (!(typeof pc === "number" && pc < Infinity && pc > -Infinity)) H.checkPc(pc); return pc;`;
}

/** Emit one independent shard factory. Its function object is never edited after creation. */
function residentShardProgram(shard: ResidentShard, binding: DirectJitBinding): string[] {
  const registers = Array.from({ length: shard.maxSlots }, (_, index) => `v${index}`);
  const stepInside = residentPcSpan(shard.entries);
  const lines = [
    `function stepShard${shard.id}(F, deadline, pc) {`,
    ...prelude(registers),
    'while (true) {',
    'switch (pc) {',
  ];
  shard.entries.forEach((entry) => {
    lines.push(
      `case ${entry.pc}: {`,
      ...entry.barrier,
      ...entry.guard,
      `S[${binding.pc.index}] = ${entry.nextPc};`,
      dirty('SD', binding.pc.index),
      ...entry.prefix,
      ...(entry.duration === undefined ? [] : elapsed(entry, entry.resumeId)),
      ...entry.suffix,
      residentStepFinish(entry.stop, stepInside, binding.pc.index),
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
        residentResumeFinish(entry.stop, binding.pc.index),
        '}',
      );
    });
    lines.push('default: throw new TypeError("Unknown direct JIT continuation");', '}', '}');
  }
  return lines;
}

function compileResidentShard(
  state: DirectJitCacheState,
  shard: ResidentShard,
  binding: DirectJitBinding,
): void {
  const lines = residentShardProgram(shard, binding);
  const resume = shard.resumable ? `resumeShard${shard.id}` : 'undefined';
  const factory = new Function(
    'C',
    'H',
    `"use strict";\n${lines.join('\n')}\nreturn [stepShard${shard.id}, ${resume}];`,
  ) as (
    constants: readonly unknown[],
    runtimeHelpers: typeof helpers,
  ) => [ResidentStep, ResidentResume | undefined];
  const [step, resumeFunction] = factory(Object.freeze([...state.constants]), helpers);
  shard.functions = { step, resume: resumeFunction };
  shard.signature = Object.freeze([...shard.entries]);
  shard.dirty = false;
  state.stats.compiledShards++;
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
  syncResidentShards(state, entries, shardSize);
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

/** Elapse due time, resume save and deadline split shared by both emitters. */
function elapsed(entry: Instruction, resumeId: number): string[] {
  if (entry.duration === undefined) return [];
  // A computed duration is validated where the generic host validates it, before it is used.
  const duration = entry.dynamicDuration ? `H.checkDuration(${entry.duration})` : entry.duration;
  return [
    `F.due = F.time + ${duration};`,
    'if (F.due > 7200000000000000) throw new RangeError("Time out of range");',
    'if ((F.publishPending && F.due > F.time) || F.due >= deadline) {',
    ...entry.slots.map((slot, slotIndex) => `L[${slotIndex}] = ${slot};`),
    `F.resume = ${resumeId};`,
    'if (F.publishPending && F.due > F.time) return "invalidated";',
    'F.time = deadline;',
    'return "deadline";',
    '}',
    'F.time = F.due;',
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
  private labels = 0;

  constructor(
    private readonly binding: DirectJitBinding,
    private readonly capture: (value: unknown) => string,
  ) {}

  compile(instruction: { pc: number; nextPc: number; body: RegionIR }): this {
    this.pcValue = instruction.pc;
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
    if (!this.terminated && !this.stop) throw unsupported;
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
   * Runtime write barrier. A block that may write a state or memory the runtime currently
   * observes returns `fallback` before it touches any slot, so the interpreter performs that
   * instruction and observers still see every write. Testing the masks at entry — instead of
   * declining the block at compile time — keeps one program valid across observer changes.
   * Resumed instructions keep their old behaviour: a continuation always completes its
   * suffix, because the interpreter can no longer replay it from that PC.
   */
  private emitBarrier(): string[] {
    const lines: string[] = [];
    const emit = (bank: 'BS' | 'BM', indices: ReadonlySet<number>): void => {
      if (!indices.size) return;
      const words = new Map<number, number>();
      for (const index of indices)
        words.set(index >>> 5, (words.get(index >>> 5) ?? 0) | (1 << (index & 31)));
      for (const [word, mask] of [...words].sort(([left], [right]) => left - right))
        lines.push(`if (${bank}[${word}] & ${mask >>> 0}) return "fallback";`);
    };
    emit('BS', this.writtenStates);
    emit('BM', this.writtenMemories);
    return lines;
  }

  private get terminated(): boolean {
    return this.duration !== undefined || this.immediate;
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
    const lines = [...this.prefix, ...this.suffix];
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
   * A call per condition dominated small instruction blocks. A condition the analyzer proved
   * boolean needs no test at all.
   */
  private condition(id: number): string {
    const folded = this.folded.get(id);
    if (folded !== undefined && typeof folded.value === 'boolean') return folded.text;
    return guard(this.value(id));
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
    if (!validIndex(index) || (write && this.binding.blockedStates?.has(name))) throw unsupported;
    (write ? this.writeStates : this.readStates).add(name);
    if (write) this.writtenStates.add(index);
    return index;
  }

  private memory(operation: { readonly kind: string; readonly memory: MemoryRefIR }): number {
    if (operation.memory.kind !== 'memory') throw unsupported;
    const name = operation.memory.name;
    const index = this.binding.memories.get(name);
    const write = operation.kind.startsWith('store');
    // Only stores are write barriers; every load kind, including the wide ones, stays eligible.
    if (!validIndex(index) || (write && this.binding.blockedMemories?.has(name))) throw unsupported;
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
        values.set(operation.result, `(${operator}${value})`);
        return true;
      }
      case 'binary': {
        const operator = binary[operation.operator];
        const left = operand(operation.left);
        const right = operand(operation.right);
        if (!operator || left === undefined || right === undefined) return false;
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
        const owner = predicates.has(operation.builtin) ? 'Number' : 'Math';
        values.set(operation.result, `${owner}.${operation.builtin}(${args.join(',')})`);
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
    for (const operation of region.operations) {
      if (operation.kind === 'yield') {
        if (!output) throw unsupported;
        lines.push(`${output.slot} = ${this.value(operation.value)}; break ${output.label};`);
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
        lines.push(`S[${index}] = ${this.value(operation.value)};`, dirty('SD', index));
        break;
      }
      case 'unary': {
        const operator = unary[operation.operator];
        if (!operator) throw unsupported;
        assign(`(${operator}${this.value(operation.value)})`);
        break;
      }
      case 'binary': {
        const operator = binary[operation.operator];
        if (!operator) throw unsupported;
        const left = this.value(operation.left);
        const right = this.value(operation.right);
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
      case 'readSample':
        if (operation.pin.kind !== 'pin') throw unsupported;
        assign(`F.host.sample(${this.capture(operation.pin.name)})`);
        break;
      case 'writeIntent':
        if (operation.pin.kind !== 'pin') throw unsupported;
        lines.push(
          `F.host.intent(${this.capture(operation.pin.name)}, ${this.value(operation.value)});`,
        );
        break;
      case 'resistor':
        if (operation.to.kind !== 'pin') throw unsupported;
        assign(
          `F.host.resistor(${this.capture(operation.to.name)}, ${this.value(operation.resistance)})`,
        );
        break;
      case 'combineIntents':
        assign(`H.combineIntents([${operation.values.map((id) => this.value(id)).join(',')}])`);
        break;
      case 'field':
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
        assign(operation.left.name === operation.right.name ? 'true' : 'false');
        break;
      case 'length':
        assign(`${this.value(operation.value)}.length`);
        break;
      case 'optional':
        assign(this.value(operation.value));
        break;
      case 'isNone':
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
        );
        break;
      }
      case 'and':
      case 'or': {
        if (operation.right.body.operations.at(-1)?.kind !== 'yield') throw unsupported;
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
      case 'if':
        lines.push(`if (${this.condition(operation.condition)}) {`);
        this.region(operation.yes, lines, output);
        if (operation.no) {
          lines.push('} else {');
          this.region(operation.no, lines, output);
        }
        lines.push('}');
        break;
      case 'select': {
        const condition = this.condition(operation.condition);
        const yes = this.expression(operation.yes);
        const no = yes === undefined ? undefined : this.expression(operation.no);
        if (yes !== undefined && no !== undefined) {
          lines.push(`${result} = ${condition} ? ${yes} : ${no};`);
          break;
        }
        const label = `select${this.labels++}`;
        lines.push(`${label}: {`, `if (${condition}) {`);
        this.region(operation.yes.body, lines, { slot: result!, label });
        lines.push('} else {');
        this.region(operation.no.body, lines, { slot: result!, label });
        lines.push('}', '}');
        break;
      }
      default:
        throw unsupported;
    }
  }
}
