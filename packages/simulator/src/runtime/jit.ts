import {
  compileDirectJit,
  type DirectJitBinding,
  type DirectJitFrame,
  type DirectJitHost,
  type DirectJitInstruction,
  type DirectJitSession,
  type DirectJitSessionStats,
  type ExecutionSignal,
} from '@mica-js/compiler';
import { createJitBlockBuilder, validateBoundBlockIR } from '@mica-js/device-model';
import { isPollingInstruction } from '../polling';
import type { EventQueue } from '../queue';
import { acceptSync } from './errors';
import { body, time } from './execution';
import type { Instance, InstanceBoard } from './instance';
import type {
  Dependencies,
  DirectExecution,
  DirectJitLayout,
  Jit,
  JitInstruction,
  JitMetadataRegion,
  JitPollingBinding,
} from './state';
import type {
  JitCodeChange,
  JitCodeMetadataInput,
  JitCodeRegion,
  JitCodeRegionView,
  JitDelay,
  RuntimeDiagnosticCode,
  RuntimePhase,
  SimulationError,
} from '../types';
import { bytesView, finite } from '../values';

/** Large programs dispatch through shards; small ones stay on the faster monolithic form. */
const DIRECT_SHARD_SIZE = 32;

export function syncJitCall(jit: Jit, name: string): unknown {
  const step = jit.host.call(name, []).next();
  if (!step.done) throw new TypeError('Unexpected suspension in synchronous function');
  return step.value;
}
/** Call sites that settle a publication boundary; used only by opt-in diagnostics. */
export type BoundarySource =
  | 'checkpointPublish'
  | 'checkpointFinish'
  | 'jitSignal'
  | 'runJit'
  | 'runDirect'
  | 'polling'
  | 'process'
  | 'other';

/**
 * Deterministic direct-execution counters, kept on the `Jit` itself so `Board.jits` stays the
 * only diagnostic surface: the benchmark reads them instead of patching runtime internals.
 */
export interface DirectJitStats {
  /** Successful fixed-dispatcher installs; observer churn and batches must not move it. */
  directCompiles: number;
  /** Resident shard functions in the active session. */
  directShards: number;
  directCalls: number;
  directFallbacks: number;
  directDeadlines: number;
  directStopped: number;
  /** Fixed dispatchers installed; one per successful session creation. */
  directSessions: number;
  /** Shard functions emitted across all sessions. */
  directShardCompiles: number;
  /** Route entries installed after their body or shard changed. */
  directRouteInstalls: number;
  /** Route entries removed because their PC was replaced, rejected or disposed. */
  directRouteRemovals: number;
  /** Dispatchable PCs in the active session. */
  directRoutes: number;
  /** Dispatch attempts that hit an untranslated or pending PC. */
  directDispatchMisses: number;
  /** Instructions the interpreter actually started executing. */
  directGenericInstructions: number;
  /** Cumulative generated characters of emitted instruction bodies. */
  directBodyBytes: number;
  /** Cumulative generated characters of emitted shard functions. */
  directShardBytes: number;
  /** Cumulative generated characters of fixed dispatchers. */
  directDispatcherBytes: number;
  /** Cumulative generated characters of synchronous helper functions. */
  directHelperBytes: number;
}

/**
 * Opt-in checkpoint counters. They live beside `directStats` so diagnostic hosts that
 * pre-install the legacy `directStats` shape keep paying nothing for these measurements.
 */
export interface DirectCheckpointStats {
  /** `publishCheckpoint` entries. */
  publications: number;
  /** `finishCheckpoint` entries. */
  finishes: number;
  /** Finish entries whose suffix only advanced time. */
  emptySuffixes: number;
  /** Boundary settlements requested by either checkpoint. */
  boundaryCalls: number;
  /** Checkpoints that returned true and stayed in Direct execution. */
  continues: number;
  /** Checkpoints that returned false and handed control back to the scheduler. */
  exits: number;
}

const checkpointStatsByJit = new WeakMap<Jit, DirectCheckpointStats>();

/** Create the opt-in checkpoint counters once, on the first instrumented Direct frame. */
export function directCheckpointStats(jit: Jit): DirectCheckpointStats {
  let stats = checkpointStatsByJit.get(jit);
  if (stats === undefined) {
    stats = {
      publications: 0,
      finishes: 0,
      emptySuffixes: 0,
      boundaryCalls: 0,
      continues: 0,
      exits: 0,
    };
    checkpointStatsByJit.set(jit, stats);
  }
  return stats;
}

/** Read counters without creating them; undefined means diagnostics stayed off. */
export function readDirectCheckpointStats(jit: Jit): DirectCheckpointStats | undefined {
  return checkpointStatsByJit.get(jit);
}

type CountedJit = Jit & { directStats?: DirectJitStats };

/** Word masks written by compiled blocks to trigger instruction-boundary publication. */
interface DirectBarriers {
  stateMask: Int32Array;
  memoryMask: Int32Array;
  /** Bank layout of the active session; absent until one has been compiled. */
  stateIndex?: ReadonlyMap<string, number>;
  memoryIndex?: ReadonlyMap<string, number>;
}

/** Frame fields `compileDirectJit` reads but `DirectJitFrame` does not declare. */
interface BarrierFrame extends DirectJitFrame {
  blockedStates?: Int32Array;
  blockedMemories?: Int32Array;
}

const barriers = new WeakMap<Jit, DirectBarriers>();

function directBarriers(jit: Jit): DirectBarriers {
  let entry = barriers.get(jit);
  if (entry === undefined) {
    entry = { stateMask: new Int32Array(0), memoryMask: new Int32Array(0) };
    barriers.set(jit, entry);
  }
  return entry;
}

function directStats(jit: Jit): DirectJitStats {
  const counted = jit as CountedJit;
  return (counted.directStats ??= {
    directCompiles: 0,
    directShards: 0,
    directCalls: 0,
    directFallbacks: 0,
    directDeadlines: 0,
    directStopped: 0,
    directSessions: 0,
    directShardCompiles: 0,
    directRouteInstalls: 0,
    directRouteRemovals: 0,
    directRoutes: 0,
    directDispatchMisses: 0,
    directGenericInstructions: 0,
    directBodyBytes: 0,
    directShardBytes: 0,
    directDispatcherBytes: 0,
    directHelperBytes: 0,
  });
}

/** Direct execution counters of one JIT; absent until it first attempted an instruction. */
export function directJitStats(jit: Jit): DirectJitStats | undefined {
  return (jit as CountedJit).directStats;
}

interface DirectSessionSnapshot {
  readonly session: DirectJitSession;
  readonly stats: DirectJitSessionStats;
}

const directSessionSnapshots = new WeakMap<Jit, DirectSessionSnapshot>();

/**
 * Fold monotonic session counters into the per-JIT totals and publish the current route and
 * shard counts. Called after every commit so the benchmark never inspects session internals.
 */
function syncDirectSessionStats(jit: Jit, session: DirectJitSession): void {
  const next = session.stats();
  const stats = directStats(jit);
  const previous = directSessionSnapshots.get(jit);
  const base = previous?.session === session ? previous.stats : undefined;
  stats.directShardCompiles += next.compiledShards - (base?.compiledShards ?? 0);
  stats.directRouteInstalls += next.routeInstalls - (base?.routeInstalls ?? 0);
  stats.directRouteRemovals += next.routeRemovals - (base?.routeRemovals ?? 0);
  stats.directBodyBytes += next.bodyBytes - (base?.bodyBytes ?? 0);
  stats.directShardBytes += next.shardBytes - (base?.shardBytes ?? 0);
  stats.directDispatcherBytes += next.dispatcherBytes - (base?.dispatcherBytes ?? 0);
  stats.directHelperBytes += next.helperBytes - (base?.helperBytes ?? 0);
  stats.directShards = next.shards;
  stats.directRoutes = next.routes;
  directSessionSnapshots.set(jit, { session, stats: next });
}

/** Drop the active session and publish zero current counts; cumulative totals stay. */
function releaseDirectSession(jit: Jit): void {
  const direct = jit.direct;
  if (direct !== undefined) {
    syncDirectSessionStats(jit, direct.session);
    jit.direct = undefined;
    direct.session.dispose();
    directSessionSnapshots.delete(jit);
    jit.directMemories.clear();
  }
  const stats = directJitStats(jit);
  if (stats !== undefined) {
    stats.directShards = 0;
    stats.directRoutes = 0;
  }
}

/** Mark the active session stale; an idle session is released immediately. */
function staleDirectSession(jit: Jit, running: boolean): boolean {
  const direct = jit.direct;
  if (direct === undefined) {
    jit.directStale = false;
    return false;
  }
  jit.directStale = true;
  if (running || direct.frame.resume !== 0) {
    // The generated function currently using the session must finish the old prefix/suffix
    // exactly once; the runtime releases the session when it returns `invalidated`.
    direct.frame.stopAfterInstruction = true;
    return true;
  }
  releaseDirectSession(jit);
  jit.directStale = false;
  return true;
}

/** Invalidate direct execution because its translation inputs changed. */
export function invalidateDirect(jit: Jit, cacheInvalid = false): void {
  if (cacheInvalid) jit.directCacheInvalid = true;
  jit.directSkip = undefined;
  staleDirectSession(jit, false);
}

/** Release the session on explicit registration/board disposal. */
export function disposeDirect(jit: Jit): void {
  releaseDirectSession(jit);
  jit.directStale = false;
  jit.directSkip = undefined;
  jit.directMemories.clear();
}

/** Region that supplies bytes for a logical PC; undefined means the service-PC fallback. */
function codeRegionFor(jit: Jit, pc: number): JitCodeRegion | undefined {
  for (const region of jit.codeRegions)
    if (pc >= region.base && pc < region.base + region.size) return region;
  return undefined;
}

/** Additional regions stay on the interpreter; only the primary memory feeds direct programs. */
function directCodeInstruction(jit: Jit, instruction: JitInstruction): boolean {
  const region = instruction.codeRegion;
  return region === undefined || region.memory === jit.options.code;
}

/** One cache entry may join the direct session: primary code and no effective polling. */
function directAdmitted(jit: Jit, instruction: JitInstruction): boolean {
  return (
    !instruction.polling &&
    !effectivePolling(jit).has(instruction.pc) &&
    directCodeInstruction(jit, instruction)
  );
}

function directInstruction(instruction: JitInstruction): DirectJitInstruction {
  return { pc: instruction.pc, nextPc: instruction.nextPc, body: instruction.body };
}

function effectivePolling(jit: Jit): ReadonlyMap<number, JitPollingBinding> {
  return jit.metadata?.polling ?? jit.polling;
}

function effectiveDelays(jit: Jit): ReadonlyMap<number, JitDelay> {
  return jit.metadata?.delays ?? jit.delays;
}

/** Aliases of the primary memory must refresh together before a direct program is built. */
function primaryCodeRegions(jit: Jit): readonly JitCodeRegion[] {
  return jit.codeRegions.filter((region) => region.memory === jit.options.code);
}

/**
 * Lazily (re)build code-derived metadata for the requested regions. Provider calls never
 * happen from attach/store; this runs inside the translate phase immediately before the
 * polling/direct/translate decision that needs it.
 */
function ensureMetadata(board: JitRuntimeHost, jit: Jit, regions: readonly JitCodeRegion[]): void {
  const metadata = jit.metadata;
  const provider = jit.options.codeMetadata;
  if (metadata === undefined || provider === undefined) return;
  const needed: {
    readonly state: JitMetadataRegion;
    readonly changes: readonly JitCodeChange[];
    readonly version: number;
  }[] = [];
  const seen = new Set<JitMetadataRegion>();
  for (const region of regions) {
    const state = metadata.regions.get(region);
    if (state === undefined || seen.has(state)) continue;
    seen.add(state);
    const version = jit.instance.codeVersion(region.memory);
    if (state.appliedVersion === version && state.pending.length === 0 && !state.dirty) continue;
    const changes =
      state.appliedVersion === -1
        ? [
            Object.freeze({
              memory: region.memory,
              offset: 0,
              length: region.size,
            }),
          ]
        : state.pending.map((change) => Object.freeze({ ...change }));
    needed.push({ state, changes, version });
  }
  if (needed.length === 0) return;

  const prior = board.phase;
  board.phase = 'translate';
  const prepared: {
    readonly state: JitMetadataRegion;
    readonly version: number;
    readonly polling: Map<number, JitPollingBinding>;
    readonly delays: Map<number, JitDelay>;
  }[] = [];
  try {
    for (const item of needed) {
      const { region } = item.state;
      const memory = jit.instance.memory(region.memory);
      const bytes = region.size >= memory.length ? memory : memory.subarray(0, region.size);
      let valid = true;
      try {
        const code = bytesView(bytes, () => {
          if (!valid) throw board.error('OBJECT_DISPOSED', 'Metadata view expired', jit.instance);
        });
        const view: JitCodeRegionView = Object.freeze({
          memory: region.memory,
          base: region.base,
          size: region.size,
          codeVersion: item.version,
          code: code as import('../types').BorrowedBytes,
        });
        const input: JitCodeMetadataInput = Object.freeze({
          region: view,
          changes: Object.freeze(item.changes.slice()),
        });
        const result = provider(input);
        acceptSync(result);
        const captured = jit.instance.captureCodeMetadata(region, result);
        prepared.push({
          state: item.state,
          version: item.version,
          polling: captured.polling,
          delays: captured.delays,
        });
      } finally {
        valid = false;
      }
    }
    // Nothing from the provider is visible until every requested region validated.
    let primary = false;
    for (const item of prepared) {
      item.state.appliedVersion = item.version;
      item.state.dirty = false;
      item.state.pending.length = 0;
      item.state.polling.clear();
      for (const [pc, binding] of item.polling) item.state.polling.set(pc, binding);
      item.state.delays.clear();
      for (const [pc, delay] of item.delays) item.state.delays.set(pc, delay);
      if (item.state.region.memory === jit.options.code) primary = true;
    }
    metadata.polling.clear();
    metadata.delays.clear();
    for (const state of metadata.regions.values()) {
      for (const [pc, binding] of state.polling) metadata.polling.set(pc, binding);
      for (const [pc, delay] of state.delays) metadata.delays.set(pc, delay);
    }
    if (primary) {
      // Admission, polling and delay snapshots are compile-time facts of the session.
      invalidateDirect(jit, true);
    } else if (jit.direct !== undefined && !jit.directStale) {
      // A secondary provider can still revise aggregated delays. Keep the fixed dispatcher
      // and let the session recompile only entries whose descriptor changed.
      updateDirectDelays(jit);
    }
  } catch (cause) {
    throw board.wrap(cause, 'JIT_FAILED', 'translate', jit.instance);
  } finally {
    board.phase = prior;
  }
}

function ensureMetadataForPc(board: JitRuntimeHost, jit: Jit, pc: number): void {
  if (jit.metadata === undefined) return;
  const region = codeRegionFor(jit, pc) ?? jit.codeRegions[0]!;
  const needed = [region];
  // Direct programs may include every primary alias; refresh all of their delays together.
  if (
    board.execution === 'throughput' &&
    board.jits.length === 1 &&
    region.memory === jit.options.code
  )
    needed.push(...primaryCodeRegions(jit));
  ensureMetadata(board, jit, needed);
}

/** Publish the current subscriber sets into the masks the compiled blocks test on writes. */
function syncDirectBarriers(jit: Jit): void {
  const entry = directBarriers(jit);
  const { stateIndex, memoryIndex } = entry;
  if (stateIndex === undefined || memoryIndex === undefined) return;
  const fill = (
    mask: Int32Array,
    index: ReadonlyMap<string, number>,
    guards: ReadonlySet<string>,
  ): void => {
    mask.fill(0);
    for (const name of guards) {
      const slot = index.get(name);
      if (slot === undefined) continue;
      mask[slot >>> 5] = (mask[slot >>> 5] ?? 0) | (1 << (slot & 31));
    }
  };
  fill(entry.stateMask, stateIndex, jit.directStateGuards);
  fill(entry.memoryMask, memoryIndex, jit.directMemoryGuards);
}

/** Scheduling capabilities needed by JIT execution; all queues remain board-owned. */
export interface JitRuntimeHost extends Pick<InstanceBoard, 'error'> {
  time: number;
  phase: string;
  current: Instance | undefined;
  readonly execution: 'throughput' | 'precise';
  readonly executionEnd: number;
  readonly jits: readonly Jit[];
  readonly waitingJits: Set<Jit>;
  /** Parks a JIT on its recorded dependency versions; the next round scans it once. */
  parkWaiter(jit: Jit): void;
  /** Wakes or drops a parked JIT and removes its dependency registrations. */
  unparkWaiter(jit: Jit): void;
  readonly events: Pick<EventQueue<() => void>, 'time' | 'push'>;
  readonly checkpointDiagnostics: boolean;
  boundary(source?: BoundarySource): void;
  canContinueDirect(jit: Jit, horizon: number): boolean;
  queueJit(jit: Jit): void;
  wrap(
    cause: unknown,
    code: RuntimeDiagnosticCode,
    phase: RuntimePhase,
    instance?: Instance,
  ): SimulationError;
}

/** Settle one checkpoint boundary and attribute it to its source when diagnostics are on. */
function checkpointBoundary(
  board: JitRuntimeHost,
  stats: DirectCheckpointStats | undefined,
  source: 'checkpointPublish' | 'checkpointFinish',
): void {
  if (stats !== undefined) stats.boundaryCalls++;
  board.boundary(source);
}

/** Reverse-map the hook's resource slots; slot values are not bank indices. */
function entryBlockedNames(jit: Jit): {
  readonly states: ReadonlySet<string>;
  readonly memories: ReadonlySet<string>;
} {
  const states = new Set<string>();
  const memories = new Set<string>([jit.options.code]);
  const instance = jit.instance;
  for (const [name, slot] of instance.stateResources)
    if (jit.directHookReads.has(slot)) states.add(name);
  for (const [name, slot] of instance.memoryResources)
    if (jit.directHookReads.has(slot)) memories.add(name);
  return { states, memories };
}

/**
 * Refresh observer masks in place and invalidate the session only when the entry barrier
 * generation changes (the hook discovered a new state or memory dependency). Returns true
 * when the running session must stop after the current instruction.
 */
function refreshDirectGuards(jit: Jit, hookReads?: Dependencies, running = false): boolean {
  let observersChanged = false;
  let entryChanged = false;
  const instance = jit.instance;
  const hookCount = jit.directHookReads.size;
  if (hookReads) {
    for (const slot of hookReads.keys()) {
      if (jit.directHookReads.has(slot)) continue;
      jit.directHookReads.add(slot);
      // Entry blocks are compiled against the hook's current state/memory dependencies.
      // A newly discovered dependency must rebuild instead of running an old block, while
      // pin/sample reads need no entry change.
      let resource = false;
      for (const candidate of instance.stateResources.values())
        if (candidate === slot) {
          resource = true;
          break;
        }
      if (!resource)
        for (const candidate of instance.memoryResources.values())
          if (candidate === slot) {
            resource = true;
            break;
          }
      if (resource) entryChanged = true;
    }
  }
  if (
    jit.directObserverRevision === instance.observerRevision &&
    hookCount === jit.directHookReads.size &&
    !entryChanged
  )
    return false;
  jit.directObserverRevision = instance.observerRevision;
  for (const [name, slot] of instance.stateResources) {
    // Hook reads are entry barriers; only ordinary subscribers publish dynamically.
    const blocked = slot.subscribers.size > 0;
    if (jit.directStateGuards.has(name) === blocked) continue;
    if (blocked) jit.directStateGuards.add(name);
    else jit.directStateGuards.delete(name);
    observersChanged = true;
  }
  for (const [name, slot] of instance.memoryResources) {
    const blocked = slot.subscribers.size > 0;
    if (jit.directMemoryGuards.has(name) === blocked) continue;
    if (blocked) jit.directMemoryGuards.add(name);
    else jit.directMemoryGuards.delete(name);
    observersChanged = true;
  }
  let invalidated = false;
  if (entryChanged && jit.direct !== undefined) {
    // Entry masks are compile-time facts of every emitted body, so the session cannot be
    // patched. A running frame stops after its current instruction; an idle one is dropped.
    invalidated = staleDirectSession(jit, running);
  }
  if (observersChanged) {
    // Subscriber masks are shared in place: one session survives observer churn.
    syncDirectBarriers(jit);
  }
  if (observersChanged || entryChanged) jit.directSkip = undefined;
  return invalidated;
}
/**
 * Direct programs advance `frame.time` between host calls, while the board only adopts the
 * final time after `run` returns. Publish the current frame time before every host effect so
 * channel publications, electrical intents and diagnostics carry the instruction's time.
 */
function directHost(
  board: JitRuntimeHost,
  instance: Instance,
  frame: DirectJitFrame,
): DirectJitHost {
  const publishTime = (): void => {
    board.time = frame.time;
  };
  return {
    send: (name, value) => {
      publishTime();
      instance.host.send(name, value);
    },
    sample: (pin) => {
      publishTime();
      return instance.host.sample(pin);
    },
    intent: (pin, value) => {
      publishTime();
      if (instance.writeIntent(pin, value)) frame.publishPending = true;
    },
    resistor: (pin, resistance) => {
      publishTime();
      return instance.host.resistor(pin, resistance);
    },
    notify: (name) => {
      publishTime();
      instance.host.notify(name);
    },
    now: () => {
      publishTime();
      return instance.host.now();
    },
    random: () => {
      publishTime();
      return instance.host.random();
    },
    assert: (condition, message) => {
      publishTime();
      instance.host.assert(condition, message);
    },
  };
}

/** Build the numeric bank layout once; rebuilds then only need the cached instruction bodies. */
function directLayout(jit: Jit): DirectJitLayout {
  if (jit.directLayout !== undefined) return jit.directLayout;
  const instance = jit.instance;
  const bank = instance.directStateBank();
  const memoryNames = [...instance.memories.keys()];
  const memories = new Map(memoryNames.map((name, index) => [name, index]));
  const memoryBanks = memoryNames.map((name) => instance.memory(name));
  const memoryViews = memoryBanks.map(
    (memory) => new DataView(memory.buffer, memory.byteOffset, memory.byteLength),
  );
  const pinNames = [...instance.pins.keys()];
  const pins = new Map(pinNames.map((name, index) => [name, index]));
  const pinObjects = pinNames.map((name) => instance.pin(name));
  const pinElectricalSlots = Int32Array.from(pinObjects, (pin) =>
    instance.board.electricalSlot(pin),
  );
  jit.directLayout = {
    ...bank,
    memoryNames: Object.freeze(memoryNames),
    memories,
    memoryBanks: Object.freeze(memoryBanks),
    memoryViews: Object.freeze(memoryViews),
    pinNames: Object.freeze(pinNames),
    pins,
    pinObjects: Object.freeze(pinObjects),
    pinElectricalSlots,
  };
  return jit.directLayout;
}

function flushDirect(
  board: JitRuntimeHost,
  instance: Instance,
  layout: DirectJitLayout,
  frame: DirectJitFrame,
): boolean {
  board.time = frame.time;
  frame.publishPending = false;
  let wrote = instance.commitDirectStates(frame.stateDirty);
  for (let word = 0; word < frame.memoryDirty.length; word++) {
    let bits = frame.memoryDirty[word]!;
    if (bits === 0) continue;
    frame.memoryDirty[word] = 0;
    while (bits !== 0) {
      const slot = word * 32 + 31 - Math.clz32(bits & -bits);
      instance.memoryChanged(layout.memoryNames[slot]!);
      bits &= bits - 1;
      wrote = true;
    }
  }
  return wrote;
}

interface RuntimeDirectFrame extends DirectJitFrame {
  /** The checkpoint already published the exit boundary before returning to the scheduler. */
  boundarySettled: boolean;
}

/** Declared busy-wait heads fold their remaining rounds inside the emitted body. */
function directDelayLoops(
  jit: Jit,
  layout: DirectJitLayout,
): ReadonlyMap<
  number,
  {
    readonly counter: number;
    readonly cycles: number;
    readonly pending?: { readonly state: number; readonly period: number; readonly active: number };
  }
> {
  const delayLoops = new Map<
    number,
    {
      counter: number;
      cycles: number;
      pending?: { state: number; period: number; active: number };
    }
  >();
  for (const [headPc, delay] of effectiveDelays(jit)) {
    const counter = layout.states.get(delay.counter);
    if (counter === undefined) continue;
    const pending =
      delay.pending === undefined
        ? undefined
        : {
            state: layout.states.get(delay.pending.state),
            period: layout.states.get(delay.pending.period),
            active: layout.states.get(delay.pending.active),
          };
    delayLoops.set(
      headPc,
      pending !== undefined &&
        pending.state !== undefined &&
        pending.period !== undefined &&
        pending.active !== undefined
        ? { counter, cycles: delay.cycles, pending: pending as never }
        : { counter, cycles: delay.cycles },
    );
  }
  return delayLoops;
}

/** Binding identity of one session; the compiler keys body and shard reuse off it. */
function directBinding(jit: Jit, layout: DirectJitLayout): DirectJitBinding {
  const { states, memories, pins } = layout;
  const entry = entryBlockedNames(jit);
  return {
    states,
    memories,
    pins,
    pc: { name: jit.options.pc, index: states.get(jit.options.pc)! },
    host: true,
    ...(jit.functions === undefined ? {} : { functions: jit.functions }),
    split: true,
    shardSize: DIRECT_SHARD_SIZE,
    delayLoops: directDelayLoops(jit, layout),
    entryBlockedStates: entry.states,
    entryBlockedMemories: entry.memories,
    blockedStates: jit.directStateGuards,
    blockedMemories: jit.directMemoryGuards,
  };
}

/** Grow the frame's local bank only between runs, never while a suffix is suspended. */
function growDirectLocals(direct: DirectExecution): void {
  if (direct.frame.resume === 0 && direct.frame.locals.length < direct.session.localCount)
    direct.frame.locals.length = direct.session.localCount;
}

/** Reconcile busy-wait descriptors; the session recompiles only affected entries. */
function updateDirectDelays(jit: Jit): void {
  const direct = jit.direct;
  if (direct === undefined || jit.directStale) return;
  // A suspended suffix keeps its old function and locals; only the route table may change.
  direct.session.updateDelays(directDelayLoops(jit, jit.directLayout!));
  growDirectLocals(direct);
  syncDirectSessionStats(jit, direct.session);
}

function addDirectInstructions(jit: Jit, instructions: readonly JitInstruction[]): void {
  const direct = jit.direct;
  if (direct === undefined || jit.directStale || direct.frame.resume !== 0) return;
  const admitted: JitInstruction[] = [];
  for (const instruction of instructions)
    if (directAdmitted(jit, instruction)) admitted.push(instruction);
  // Translation callbacks may append static delay declarations for this same batch.
  direct.session.updateDelays(directDelayLoops(jit, jit.directLayout!));
  if (admitted.length) {
    direct.session.add(admitted.map(directInstruction));
    for (const instruction of admitted)
      jit.directMemories.add(instruction.codeRegion?.memory ?? jit.options.code);
    growDirectLocals(direct);
  }
  syncDirectSessionStats(jit, direct.session);
}

/**
 * Commit one translated block to the active session. Overlapping replacements are handled by
 * the session when idle. While an old suffix is suspended, translation must not retarget it:
 * the session is marked stale so the suffix finishes once and a fresh session rebuilds.
 */
function commitDirectTranslation(
  jit: Jit,
  instructions: readonly JitInstruction[],
  replaced: boolean,
): void {
  const direct = jit.direct;
  if (direct === undefined || jit.directStale) return;
  if (direct.frame.resume !== 0) {
    // Do not retarget the suspended instruction. Delay declarations outside its route still
    // apply to entries that can be reached after the suffix completes.
    if (replaced) staleDirectSession(jit, false);
    else updateDirectDelays(jit);
    return;
  }
  addDirectInstructions(jit, instructions);
}

/** Install the fixed dispatcher and seed it from every admission-eligible cached entry. */
function ensureDirectSession(board: JitRuntimeHost, jit: Jit): DirectExecution | undefined {
  if (jit.direct !== undefined) return jit.direct;
  if (jit.directStale) jit.directStale = false;
  const layout = directLayout(jit);
  if (jit.directCacheInvalid) {
    // Bodies from the previous code generation must never resurface through `rebuildAll`.
    // A cache that never existed has nothing to clear and must not consume the write marker
    // that the first real replacement needs.
    if (jit.directCache !== undefined) compileDirectJit.clearCache(jit.directCache);
    jit.directCacheInvalid = false;
  }
  const cache = (jit.directCache ??= compileDirectJit.createCache());
  let session: DirectJitSession | undefined;
  const admitted: JitInstruction[] = [];
  try {
    session = compileDirectJit.createSession(directBinding(jit, layout), cache);
    for (const instruction of jit.cache.values())
      if (directAdmitted(jit, instruction)) admitted.push(instruction);
    if (admitted.length) session.add(admitted.map(directInstruction));
    session.updateDelays(directDelayLoops(jit, layout));
  } catch (cause) {
    session?.dispose();
    throw cause;
  }
  for (const instruction of admitted)
    jit.directMemories.add(instruction.codeRegion?.memory ?? jit.options.code);

  const barrier = directBarriers(jit);
  barrier.stateIndex = layout.states;
  barrier.memoryIndex = layout.memories;
  const stateMaskWords = Math.ceil(layout.stateNames.length / 32);
  const memoryMaskWords = Math.ceil(layout.memoryNames.length / 32);
  if (barrier.stateMask.length !== stateMaskWords)
    barrier.stateMask = new Int32Array(stateMaskWords);
  if (barrier.memoryMask.length !== memoryMaskWords)
    barrier.memoryMask = new Int32Array(memoryMaskWords);
  syncDirectBarriers(jit);

  const frame = createDirectFrame(board, jit, layout, session, barrier);
  const execution: DirectExecution = {
    session,
    frame,
    get pcs(): ReadonlySet<number> {
      return new Set(session.pcs);
    },
  };
  jit.direct = execution;
  jit.directStale = false;
  const stats = directStats(jit);
  stats.directCompiles++;
  stats.directSessions++;
  syncDirectSessionStats(jit, session);
  return execution;
}

function createDirectFrame(
  board: JitRuntimeHost,
  jit: Jit,
  layout: DirectJitLayout,
  session: DirectJitSession,
  barrier: DirectBarriers,
): RuntimeDirectFrame {
  const instance = jit.instance;
  const { pinObjects, pinNames, pinElectricalSlots } = layout;
  // Counters are created once, only when the benchmark opted in; legacy directStats is untouched.
  const checkpointStats = board.checkpointDiagnostics ? directCheckpointStats(jit) : undefined;
  const frame: RuntimeDirectFrame = {
    states: layout.stateValues,
    memories: [...layout.memoryBanks],
    memoryViews: layout.memoryViews,
    pins: pinObjects,
    resistors: [],
    locals: new Array(session.localCount),
    stateDirty: new Int32Array(Math.ceil(layout.stateNames.length / 32)),
    memoryDirty: new Int32Array(Math.ceil(layout.memoryNames.length / 32)),
    time: board.time,
    due: board.time,
    resume: 0,
    // First resumption must not add a property to a frame already seen by hot shards.
    stopAfterInstruction: false,
    boundarySettled: false,
  };
  frame.writePinIntent = (pinIndex: number, value: unknown): void => {
    if (!Object.hasOwn(instance, 'writeIntent')) {
      const pin = pinObjects[pinIndex]!;
      if (pin.intent === value) return;
      pin.intent = value as never;
      instance.board.markElectricalDirty(pinElectricalSlots[pinIndex]!);
      frame.publishPending = true;
      return;
    }
    board.time = frame.time;
    if (instance.writeIntent(pinNames[pinIndex]!, value)) frame.publishPending = true;
  };
  (frame as { host?: DirectJitHost }).host = directHost(board, instance, frame);
  if (jit.metadata === undefined) {
    frame.publishCheckpoint = () => {
      if (checkpointStats !== undefined) checkpointStats.publications++;
      flushDirect(board, instance, layout, frame);
      // Writeback has completed before the boundary observes the published state.
      checkpointBoundary(board, checkpointStats, 'checkpointPublish');
      if (
        jit.directStale ||
        jit.direct?.session !== session ||
        !board.canContinueDirect(jit, frame.due)
      ) {
        frame.boundarySettled = true;
        if (checkpointStats !== undefined) checkpointStats.exits++;
        return false;
      }
      // The boundary may have run reactions with their own current instance.
      board.current = instance;
      if (checkpointStats !== undefined) checkpointStats.continues++;
      return true;
    };
    if (jit.options.beforeInstruction === undefined) {
      const pcIndex = layout.states.get(jit.options.pc)!;
      frame.finishCheckpoint = (deadline, emptySuffix) => {
        if (checkpointStats !== undefined) {
          checkpointStats.finishes++;
          if (emptySuffix) checkpointStats.emptySuffixes++;
        }
        // The prefix was flushed and admitted through due. An empty suffix only
        // advances time, so that scheduler admission still holds after its boundary.
        if (emptySuffix) board.time = frame.time;
        else flushDirect(board, instance, layout, frame);
        checkpointBoundary(board, checkpointStats, 'checkpointFinish');
        const nextPc = frame.states[pcIndex] as number;
        if (
          jit.directStale ||
          jit.direct?.session !== session ||
          !session.has(nextPc) ||
          jit.directSkip === nextPc ||
          frame.time >= deadline ||
          board.events.time < deadline ||
          (!emptySuffix && !board.canContinueDirect(jit, frame.time))
        ) {
          frame.boundarySettled = true;
          if (checkpointStats !== undefined) checkpointStats.exits++;
          return false;
        }
        // Route membership excludes polling/secondary-code PCs. Barriers may still have
        // changed during reactions; the next generated block checks the refreshed masks.
        if (jit.directObserverRevision !== instance.observerRevision) {
          // A new entry-barrier dependency can only take effect without running another
          // instruction: the current generated shard function must return first.
          if (refreshDirectGuards(jit, undefined, true)) {
            frame.boundarySettled = true;
            if (checkpointStats !== undefined) checkpointStats.exits++;
            return false;
          }
        }
        frame.stopAfterInstruction = false;
        board.current = instance;
        if (checkpointStats !== undefined) checkpointStats.continues++;
        return true;
      };
    }
  }
  // Both masks are shared with every frame of this JIT and refreshed in place on guard churn.
  (frame as BarrierFrame).blockedStates = barrier.stateMask;
  (frame as BarrierFrame).blockedMemories = barrier.memoryMask;
  return frame;
}
type DirectOutcome = 'ran' | 'fallback' | 'assembly' | 'assembly-progressed' | 'declined';

/**
 * Run the fixed dispatcher. `untranslated`/`pending` return to `runJit` as an assembly
 * request; `fallback` means the compiler rejected a PC and the interpreter must take it.
 */
function runDirect(board: JitRuntimeHost, jit: Jit, hookReads?: Dependencies): DirectOutcome {
  const instance = jit.instance;
  let pending = Boolean(jit.direct?.frame.resume);
  if (!pending) {
    if (jit.directStale) {
      releaseDirectSession(jit);
      jit.directStale = false;
    }
    const pc = finite(instance.states.get(jit.options.pc), 'pc');
    const region = codeRegionFor(jit, pc);
    if (
      board.execution !== 'throughput' ||
      board.jits.length !== 1 ||
      (region !== undefined && region.memory !== jit.options.code) ||
      effectivePolling(jit).has(pc) ||
      jit.cache.get(pc)?.polling
    )
      return 'declined';
    refreshDirectGuards(jit, hookReads);
    if (jit.directSkip === pc) return 'declined';
    if (jit.direct === undefined && ensureDirectSession(board, jit) === undefined)
      return 'declined';
  }
  const direct = jit.direct!;
  const frame = direct.frame as RuntimeDirectFrame;
  const layout = jit.directLayout!;
  for (;;) {
    if (pending) frame.stopAfterInstruction = true;
    frame.time = board.time;
    // The frame starts clean and flushDirect clears both banks, including the fault path.
    const start = board.time;
    let reason: ReturnType<DirectJitSession['run']>;
    let wrote: boolean;
    const stats = directStats(jit);
    stats.directCalls++;
    try {
      // Resource barriers exclude intermediate observers; real events retain exact deadlines.
      reason = direct.session.run(frame, Math.min(board.executionEnd, board.events.time));
    } finally {
      wrote = flushDirect(board, instance, layout, frame);
    }
    const progressed = wrote || board.time !== start;
    // An assembly request that executed nothing is not a settled boundary; the scheduler
    // translates and retries in the same turn. A fallback with no progress is likewise left
    // for the interpreter without a boundary.
    if (frame.boundarySettled) frame.boundarySettled = false;
    else if (
      reason === 'fallback' || reason === 'untranslated' || reason === 'pending' ? progressed : true
    )
      board.boundary('runDirect');
    if (reason === 'untranslated' || reason === 'pending') {
      stats.directDispatchMisses++;
      if (jit.directStale && frame.resume === 0) {
        releaseDirectSession(jit);
        jit.directStale = false;
      }
      return progressed ? 'assembly-progressed' : 'assembly';
    }
    if (reason === 'fallback') {
      const nextPc = finite(instance.states.get(jit.options.pc), 'pc');
      // Polling PCs are deliberately absent from direct sessions. Reaching one is a normal
      // shard boundary, not a failed direct dispatch, so it must neither compound fallback
      // statistics nor poison the next interpreter attempt for this PC.
      const polling = effectivePolling(jit).has(nextPc) || jit.cache.get(nextPc)?.polling;
      if (!polling) {
        stats.directFallbacks++;
        jit.directSkip = nextPc;
      }
      if (!progressed && board.time < board.executionEnd) return 'fallback';
    } else if (reason === 'stopped') {
      stats.directStopped++;
      jit.stopped = true;
      if (jit.directStale && frame.resume === 0) {
        releaseDirectSession(jit);
        jit.directStale = false;
      }
      return 'ran';
    } else if (reason === 'invalidated') {
      frame.stopAfterInstruction = false;
      // The old suffix completed after its inputs changed; drop the session before a new
      // turn rebuilds it from the current translation cache.
      if (jit.directStale && frame.resume === 0) {
        releaseDirectSession(jit);
        jit.directStale = false;
      }
    } else stats.directDeadlines++;
    if (jit.direct === undefined) {
      board.queueJit(jit);
      return 'ran';
    }
    // Publish and settle the whole boundary first. Without intervening scheduler work,
    // an already-started suffix can resume at its wake time without a queue round trip.
    // A metadata provider must still be checked by runJit before resumption.
    if (frame.resume) {
      const wake = Math.max(frame.due, board.time);
      if (jit.metadata === undefined && !jit.directStale && board.canContinueDirect(jit, wake)) {
        board.time = wake;
        board.current = instance;
        pending = true;
        continue;
      }
      if (wake > board.time) {
        board.events.push(wake, () => board.queueJit(jit));
        return 'ran';
      }
    }
    board.queueJit(jit);
    return 'ran';
  }
}

/** A PC is ready for direct execution when its translation is not polling or secondary. */
function directPcAdmitted(jit: Jit, pc: number): boolean {
  const region = codeRegionFor(jit, pc);
  if (region !== undefined && region.memory !== jit.options.code) return false;
  if (effectivePolling(jit).has(pc)) return false;
  return jit.cache.get(pc)?.polling !== true;
}

/**
 * Satisfy one assembly request without replaying the boundary that asked for it. A missing
 * cache entry uses the same translation path as the interpreter; an existing entry is simply
 * added because it may have been translated while an old suffix was still suspended.
 */
function assembleDirect(board: JitRuntimeHost, jit: Jit, pc: number): boolean {
  // The dispatcher can hand back an alias/service PC after executing a prefix. Refresh that
  // region before deciding admission or translating it.
  if (jit.metadata !== undefined) ensureMetadataForPc(board, jit, pc);
  const direct = jit.direct;
  if (direct === undefined || jit.directStale || direct.frame.resume !== 0) return false;
  if (!directPcAdmitted(jit, pc)) return false;
  let instruction = jit.cache.get(pc);
  if (instruction === undefined) {
    translateBlock(board, jit, pc);
    instruction = jit.cache.get(pc);
    return instruction !== undefined;
  }
  if (!direct.session.has(pc)) addDirectInstructions(jit, [instruction]);
  return true;
}

/**
 * Handle `untranslated` from the dispatcher. Hooks and polling `consume` already ran for this
 * boundary, so they are never repeated here. At most one retry keeps a rejected body from
 * looping; a progressed prefix that still cannot continue direct yields to the scheduler so
 * the next instruction gets its own boundary.
 */
function retryDirectAfterAssembly(board: JitRuntimeHost, jit: Jit, progressed: boolean): boolean {
  if (progressed) {
    // The prefix already settled a boundary and may have queued reactions, ready JITs or
    // events. Never execute the flushed successor before the scheduler observes them:
    // translation and admission belong to the next turn, which reruns hook and polling.
    board.queueJit(jit);
    return true;
  }
  if (jit.direct === undefined || jit.directStale) return false;
  const pc = finite(jit.instance.states.get(jit.options.pc), 'pc');
  if (!assembleDirect(board, jit, pc)) return false;
  const retried = runDirect(board, jit);
  if (retried === 'ran') return true;
  // The retry may have completed this instruction and landed on another miss. The
  // interpreter's `pc` is stale, so the scheduler owns the next boundary.
  if (retried === 'assembly-progressed') {
    board.queueJit(jit);
    return true;
  }
  return false;
}
function pollingDependencies(
  jit: Jit,
  dependencies: Dependencies,
  pc: number | undefined,
): Dependencies {
  const result = new Map(dependencies);
  const instance = jit.instance;
  const pcSlot = instance.stateResources.get(jit.options.pc)!;
  result.set(pcSlot, pcSlot.version);
  const region = pc === undefined ? undefined : codeRegionFor(jit, pc);
  const memory = region?.memory ?? jit.options.code;
  const slot = instance.memoryResources.get(memory)!;
  result.set(slot, slot.version);
  return result;
}

/** Park a polling JIT and, when requested, schedule the next device time event. */
function waitForPolling(
  board: JitRuntimeHost,
  jit: Jit,
  dependencies: Dependencies,
  duration: number,
  advance: string | undefined,
): void {
  jit.dependencies = dependencies;
  jit.pollingWait = true;
  jit.pollingPeriod = 0;
  board.parkWaiter(jit);
  const token = ++jit.pollingToken;

  board.boundary('polling');
  if (duration === 0 || advance === undefined) return;
  const due = time(board.time + duration);

  board.events.push(due, () => {
    if (token !== jit.pollingToken || !jit.active || jit.stopped || !board.waitingJits.has(jit))
      return;
    const pending = jit.dependencies;

    delete jit.dependencies;
    board.unparkWaiter(jit);
    jit.pollingToken++;
    board.current = jit.instance;
    // An external event won the race at the same timestamp. Re-evaluate the guest rather
    // than applying a device step against a configuration that has already changed.
    if (!jit.instance.dependenciesCurrent(pending)) {
      board.queueJit(jit);
      return;
    }
    jit.instance.syncCall(advance, [duration]);
    board.boundary('polling');
    board.queueJit(jit);
  });
}

function jitSignal(board: JitRuntimeHost, jit: Jit, signal: ExecutionSignal): boolean {
  if (signal.kind === 'elapse') {
    const duration = time(signal.duration);
    if (duration === 0) return false;
    const due = time(board.time + duration);
    board.events.push(due, () => board.queueJit(jit));
    board.boundary('jitSignal');
    return true;
  }
  if (signal.kind === 'waitUntil') {
    const checked = jit.instance.evaluate(() => syncJitCall(jit, signal.predicate));
    if (checked.value === true) return false;
    jit.predicate = signal.predicate;
    jit.pollingWait = false;
    jit.dependencies = checked.dependencies;
    board.parkWaiter(jit);
    board.boundary('jitSignal');
    return true;
  }
  if (signal.kind === 'stop') {
    jit.stopped = true;
    jit.execution = undefined;
    board.boundary('jitSignal');
    return true;
  }
  if (signal.kind === 'redirect') {
    finite(signal.pc, 'redirect target');
    const duration = time(signal.delay);
    jit.instance.host.write(jit.options.pc, signal.pc);
    jit.execution = undefined;
    const polling =
      jit.automaticPolling && duration > 0 && signal.pc === jit.currentPc && jit.pollReads;
    const dependencies = polling ? pollingDependencies(jit, polling, jit.currentPc) : undefined;
    jit.automaticPolling = false;
    jit.pollReads = undefined;
    board.boundary('jitSignal');
    if (duration === 0) board.queueJit(jit);
    else
      board.events.push(time(board.time + duration), () => {
        if (!jit.active || jit.stopped) return;
        if (dependencies && jit.instance.dependenciesCurrent(dependencies)) {
          jit.dependencies = dependencies;
          jit.pollingWait = true;
          jit.pollingPeriod = duration;
          jit.pollingOrigin = board.time;
          board.parkWaiter(jit);
        } else board.queueJit(jit);
      });
    return true;
  }
  throw new TypeError('Invalid JIT suspension');
}
/**
 * Translate one PC, atomically publish the block's cache entries, and commit its admitted
 * entries to the active session. Reused by both the interpreter path and assembly retries.
 */
function translateBlock(board: JitRuntimeHost, jit: Jit, pc: number): readonly JitInstruction[] {
  const prior = board.phase;
  board.phase = 'translate';
  let valid = true;
  try {
    const codeRegion = codeRegionFor(jit, pc);
    const codeMemory = codeRegion?.memory ?? jit.options.code;
    const memory = jit.instance.memory(codeMemory);
    const bytes =
      codeRegion === undefined || codeRegion.size >= memory.length
        ? memory
        : memory.subarray(0, codeRegion.size);
    const code = bytesView(bytes, () => {
      if (!valid) throw board.error('OBJECT_DISPOSED', 'Translation view expired', jit.instance);
    });
    const result = jit.options.translate(
      Object.freeze({
        pc,
        code: code as import('../types').BorrowedBytes,
        codeBase: codeRegion?.base ?? 0,
        codeVersion: jit.instance.codeVersion(codeMemory),
      }),
      createJitBlockBuilder({ device: jit.model }),
    );
    acceptSync(result);
    const block = validateBoundBlockIR(result, jit.model);
    if (block.instructions[0]?.pc !== pc) throw new TypeError('Translated first pc does not match');
    const instructions = block.instructions.map((instruction) => {
      const region = codeRegionFor(jit, instruction.pc);
      return {
        pc: instruction.pc,
        nextPc: instruction.nextPc,
        body: instruction.body,
        polling: isPollingInstruction(instruction.body, instruction.pc, jit.options.pc),
        execute: body(instruction.body),
        codeRegion: region,
      };
    });
    // Check the old cache before publishing: an overlapping block can replace a routed body
    // instead of only adding PCs.
    const replaced = instructions.some((entry) => jit.cache.has(entry.pc));
    // Match the first instruction when a block contains a repeated PC.
    for (let index = instructions.length - 1; index >= 0; index--) {
      const entry = instructions[index]!;
      jit.cache.set(entry.pc, entry);
      jit.cacheMemories.add(entry.codeRegion?.memory ?? jit.options.code);
    }
    // A block may legally span multiple PCs. Every entry gets its own logical region; direct
    // sessions only admit primary/fallback entries. The start region only supplies the
    // translate-time byte view and codeVersion.
    if (
      instructions.some(
        (entry) => entry.codeRegion === undefined || entry.codeRegion.memory === jit.options.code,
      )
    )
      jit.revision++;
    jit.directSkip = undefined;
    commitDirectTranslation(jit, instructions, replaced);
    return instructions;
  } catch (cause) {
    throw board.wrap(cause, 'JIT_FAILED', 'translate', jit.instance);
  } finally {
    valid = false;
    board.phase = prior;
  }
}

export function runJit(board: JitRuntimeHost, jit: Jit): void {
  jit.queued = false;
  if (!jit.active || jit.stopped) return;
  board.current = jit.instance;
  if (jit.metadata !== undefined) {
    const pc = finite(jit.instance.states.get(jit.options.pc), 'pc');
    ensureMetadataForPc(board, jit, pc);
  }
  if (jit.direct?.frame.resume) {
    const outcome = runDirect(board, jit);
    // A completed suffix can land on an untranslated PC. Its old boundary is already
    // settled, so re-queue: the next turn owns hook/polling admission and translation.
    if (outcome === 'assembly' || outcome === 'assembly-progressed')
      retryDirectAfterAssembly(board, jit, true);
    return;
  }
  if (!jit.execution) {
    jit.automaticPolling = false;
    jit.pollReads = undefined;
    let hookReads: Dependencies | undefined;
    let hookPending = false;
    const hook = jit.options.beforeInstruction;
    if (hook) {
      const kind = jit.instance.declarations.get(hook.when)!.kind;
      const priorPc = jit.instance.states.get(jit.options.pc) as number;
      const collect =
        board.execution === 'throughput' &&
        (board.jits.length === 1 || effectivePolling(jit).has(priorPc));
      const checked = collect
        ? jit.instance.evaluate(() => jit.instance.read(kind, hook.when))
        : undefined;
      const handled = (checked ? checked.value : jit.instance.read(kind, hook.when)) === true;
      if (handled) {
        const execution = jit.instance.invoke(hook.call);
        const step = execution.next();
        if (!step.done) {
          jit.execution = execution;
          if (jitSignal(board, jit, step.value)) return;
          throw new TypeError('Invalid hook suspension');
        }
      }
      hookReads = checked?.dependencies;
      hookPending = handled;
    }
    const pc = finite(jit.instance.states.get(jit.options.pc), 'pc');
    if (jit.metadata !== undefined && hook !== undefined) {
      // `beforeInstruction` may redirect the PC or replace code. The translate/polling/Direct
      // decision below is for the final location, so its region must be refreshed after the
      // hook even though the entry metadata was already checked at the top of this turn.
      ensureMetadataForPc(board, jit, pc);
    }
    if (board.execution === 'throughput') {
      const declaration = effectivePolling(jit).get(pc);
      if (declaration) {
        const checked = jit.instance.evaluate(() => jit.instance.syncCall(declaration.predicate));
        if (checked.value !== true) {
          const dependencies = new Map([...(hookReads ?? []), ...checked.dependencies]);
          let duration = 0;
          const wait = declaration.wait;
          if (wait) {
            const delayed = jit.instance.evaluate(
              () => jit.instance.syncCall(wait.delay),
              dependencies,
            );
            duration = time(delayed.value);
          }
          waitForPolling(
            board,
            jit,
            pollingDependencies(jit, dependencies, pc),
            duration,
            wait?.advance,
          );
          return;
        }
        if (declaration.consume) jit.instance.syncCall(declaration.consume);
      }
      if (!hookPending && board.jits.length === 1) {
        const outcome = runDirect(board, jit, hookReads);
        if (outcome === 'ran') return;
        if (outcome === 'assembly' || outcome === 'assembly-progressed') {
          if (retryDirectAfterAssembly(board, jit, outcome === 'assembly-progressed')) return;
        }
      }
    }
    let instruction = jit.cache.get(pc);
    if (!instruction) {
      const instructions = translateBlock(board, jit, pc);
      instruction = instructions[0]!;
    }
    jit.currentPc = pc;
    if (board.execution === 'throughput' && board.jits.length === 1)
      directStats(jit).directGenericInstructions++;
    jit.automaticPolling =
      board.execution === 'throughput' &&
      board.jits.length === 1 &&
      instruction.polling &&
      !hookPending &&
      (!hook || hookReads !== undefined);
    jit.pollReads = hookReads;
    jit.instance.host.write(jit.options.pc, instruction.nextPc);
    jit.execution = instruction.execute(jit.host);
  }
  for (;;) {
    const step = jit.automaticPolling
      ? (() => {
          const checked = jit.instance.evaluate(() => jit.execution!.next());
          jit.pollReads = new Map([...(jit.pollReads ?? []), ...checked.dependencies]);
          return checked.value;
        })()
      : jit.execution.next();
    if (step.done) {
      jit.execution = undefined;
      board.boundary('runJit');
      board.queueJit(jit);
      return;
    }
    if (jitSignal(board, jit, step.value)) return;
  }
}
