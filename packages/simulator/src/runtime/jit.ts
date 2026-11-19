import {
  compileDirectJit,
  type DirectJitFrame,
  type DirectJitHost,
  type DirectJitProgram,
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
/**
 * Program size above which whole-program rebuilds are amortized instead of immediate.
 *
 * Translation only ever adds cache entries, so a compiled program stays valid for every PC it
 * already contains; only a missing PC needs a rebuild. Rebuilding on every new block is
 * quadratic, and that dominated warm-up on a real firmware image (411 blocks: 43 rebuilds and
 * ~1.7 s before any simulated time). Small programs rebuild in milliseconds, so they keep the
 * exact behaviour; only larger ones switch to a stride that grows with the program.
 */
const DIRECT_REBUILD_LINEAR_LIMIT = 16;
/** Stride floor once a program exceeds `DIRECT_REBUILD_LINEAR_LIMIT`. */
const DIRECT_REBUILD_MIN_BLOCKS = 64;
/** A repeatedly visited translated PC can force a rebuild before the append-only stride. */
const DIRECT_REBUILD_PATIENCE = 4;

function directRebuildStride(compiled: number): number {
  return compiled < DIRECT_REBUILD_LINEAR_LIMIT ? 1 : Math.max(DIRECT_REBUILD_MIN_BLOCKS, compiled);
}

/**
 * Deterministic direct-execution counters, kept on the `Jit` itself so `Board.jits` stays the
 * only diagnostic surface: the benchmark reads them instead of patching runtime internals.
 */
export interface DirectJitStats {
  /** Successful program builds; one per compile, so observer churn must not move it. */
  directCompiles: number;
  /** Resident shard functions backing the current direct program. */
  directShards: number;
  directCalls: number;
  directFallbacks: number;
  directDeadlines: number;
  directStopped: number;
}

type CountedJit = Jit & { directStats?: DirectJitStats };

/** Word masks the compiled blocks test at entry; mutated in place, so programs stay valid. */
interface DirectBarriers {
  stateMask: Int32Array;
  memoryMask: Int32Array;
  /** Bank layout of the current program; absent until one has been compiled. */
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
  });
}

/** Direct execution counters of one JIT; absent until the runtime attempted a direct run. */
export function directJitStats(jit: Jit): DirectJitStats | undefined {
  return (jit as CountedJit).directStats;
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
      jit.directPrograms.clear();
      jit.directProgramRevision = -1;
      jit.directSkip = undefined;
      if (!jit.direct?.frame.resume) {
        jit.direct = undefined;
        jit.directRevision = -1;
      }
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

/** Publish the current guard sets into the masks the compiled blocks test at entry. */
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
  readonly events: Pick<EventQueue<() => void>, 'time' | 'push'>;
  boundary(): void;
  canContinueDirect(jit: Jit, horizon: number): boolean;
  queueJit(jit: Jit): void;
  wrap(
    cause: unknown,
    code: RuntimeDiagnosticCode,
    phase: RuntimePhase,
    instance?: Instance,
  ): SimulationError;
}

function refreshDirectGuards(jit: Jit, hookReads?: Dependencies): void {
  let changed = false;
  const instance = jit.instance;
  const hookCount = jit.directHookReads.size;
  // IRQ masking and short-circuit reads must not churn the compiled barrier set.
  if (hookReads) for (const slot of hookReads.keys()) jit.directHookReads.add(slot);
  if (
    jit.directObserverRevision === instance.observerRevision &&
    hookCount === jit.directHookReads.size
  )
    return;
  jit.directObserverRevision = instance.observerRevision;
  for (const [name, slot] of instance.stateResources) {
    const blocked = slot.subscribers.size > 0 || jit.directHookReads.has(slot);
    if (jit.directStateGuards.has(name) === blocked) continue;
    if (blocked) jit.directStateGuards.add(name);
    else jit.directStateGuards.delete(name);
    changed = true;
  }
  for (const [name, slot] of instance.memoryResources) {
    const blocked =
      slot.subscribers.size > 0 || jit.directHookReads.has(slot) || name === jit.options.code;
    if (jit.directMemoryGuards.has(name) === blocked) continue;
    if (blocked) jit.directMemoryGuards.add(name);
    else jit.directMemoryGuards.delete(name);
    changed = true;
  }
  if (changed) {
    // Guards no longer invalidate the program: the compiled blocks test these masks at entry,
    // so a membership change only flips individual blocks between direct and interpreted.
    syncDirectBarriers(jit);
    // A block that fell back while it was blocked may be eligible again.
    jit.directSkip = undefined;
  }
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

function createDirectFrame(
  board: JitRuntimeHost,
  jit: Jit,
  layout: DirectJitLayout,
  program: DirectJitProgram,
  barrier: DirectBarriers,
): RuntimeDirectFrame {
  const instance = jit.instance;
  const { pinObjects, pinNames, pinElectricalSlots } = layout;
  const frame: RuntimeDirectFrame = {
    states: layout.stateValues,
    memories: [...layout.memoryBanks],
    memoryViews: layout.memoryViews,
    pins: pinObjects,
    resistors: [],
    locals: new Array(program.localCount),
    stateDirty: new Int32Array(Math.ceil(layout.stateNames.length / 32)),
    memoryDirty: new Int32Array(Math.ceil(layout.memoryNames.length / 32)),
    time: board.time,
    due: board.time,
    resume: 0,
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
      flushDirect(board, instance, layout, frame);
      board.boundary();
      if (jit.directProgramRevision === -1 || !board.canContinueDirect(jit, frame.due)) {
        frame.boundarySettled = true;
        return false;
      }
      // The boundary may have run reactions with their own current instance.
      board.current = instance;
      return true;
    };
    if (jit.options.beforeInstruction === undefined) {
      const pcIndex = layout.states.get(jit.options.pc)!;
      frame.finishCheckpoint = (deadline, emptySuffix) => {
        // The prefix was flushed and admitted through due. An empty suffix only
        // advances time, so that scheduler admission still holds after its boundary.
        if (emptySuffix) board.time = frame.time;
        else flushDirect(board, instance, layout, frame);
        board.boundary();
        const direct = jit.direct;
        const nextPc = frame.states[pcIndex] as number;
        if (
          jit.directProgramRevision === -1 ||
          direct?.frame !== frame ||
          !direct.pcs.has(nextPc) ||
          jit.directSkip === nextPc ||
          (jit.directRevision !== jit.revision &&
            jit.revision - jit.directRevision >= directRebuildStride(direct.pcs.size)) ||
          frame.time >= deadline ||
          board.events.time < deadline ||
          (!emptySuffix && !board.canContinueDirect(jit, frame.time))
        ) {
          frame.boundarySettled = true;
          return false;
        }
        // Program membership excludes polling/secondary-code PCs. Barriers may still
        // have changed during reactions; the next generated block checks the refreshed masks.
        if (jit.directObserverRevision !== instance.observerRevision) refreshDirectGuards(jit);
        frame.stopAfterInstruction = false;
        board.current = instance;
        return true;
      };
    }
  }
  // Both masks are shared with every frame of this JIT and refreshed in place on guard churn.
  (frame as BarrierFrame).blockedStates = barrier.stateMask;
  (frame as BarrierFrame).blockedMemories = barrier.memoryMask;
  return frame;
}
function runDirect(board: JitRuntimeHost, jit: Jit, hookReads?: Dependencies): boolean {
  const instance = jit.instance;
  let pending = Boolean(jit.direct?.frame.resume);
  if (!pending) {
    const pc = finite(instance.states.get(jit.options.pc), 'pc');
    const region = codeRegionFor(jit, pc);
    if (
      board.execution !== 'throughput' ||
      board.jits.length !== 1 ||
      (region !== undefined && region.memory !== jit.options.code) ||
      effectivePolling(jit).has(pc) ||
      jit.cache.get(pc)?.polling
    )
      return false;
    refreshDirectGuards(jit, hookReads);
    if (jit.directSkip === pc) return false;
    // An append-only translation revision leaves compiled bodies valid. Reuse them as long
    // as the current program covers this PC. Amortize rebuilds over a stride of new blocks,
    // but count repeat dispatches per translated PC so a hot path catches up promptly
    // without rebuilding for each PC visited once during initialization.
    if (jit.directRevision !== jit.revision) {
      const compiled = jit.direct?.pcs.size ?? 0;
      const stale = jit.revision - jit.directRevision;
      const stride = directRebuildStride(compiled);
      const covered = jit.direct?.pcs.has(pc) === true;
      const misses = covered ? 0 : (jit.directMisses.get(pc) ?? 0);
      const rebuild =
        jit.direct === undefined || stale >= stride || misses >= DIRECT_REBUILD_PATIENCE;

      if (!rebuild) {
        if (!covered) {
          // The interpreter runs this instruction; the catch-up rebuild picks it up. It is
          // still a direct attempt that fell back, so the counters keep describing "how many
          // dispatches reached the compiled program" rather than where the decision was made.
          const stats = directStats(jit);
          stats.directCalls++;
          stats.directFallbacks++;
          if (jit.cache.has(pc)) jit.directMisses.set(pc, misses + 1);

          return false;
        }
        // Covered: reuse the current program and fall through to the shared execution tail.
      } else {
        if (jit.directProgramRevision !== jit.revision) {
          // Code-memory replacement resets this marker to -1. The translated cache is gone, so
          // cached instruction bodies must go with it; old programs stay self-contained.
          if (jit.directProgramRevision === -1 && jit.directCache !== undefined)
            compileDirectJit.clearCache(jit.directCache);
          jit.directPrograms.clear();
          jit.directProgramRevision = jit.revision;
        }
        const layout = directLayout(jit);
        const instructions = [...jit.cache.values()].filter(
          (instruction) =>
            !instruction.polling &&
            !effectivePolling(jit).has(instruction.pc) &&
            directCodeInstruction(jit, instruction),
        );
        /** Declared busy-wait heads fold their remaining rounds inside the emitted body. */
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
        // Guards stay out of the key: blocks test the barriers at entry, so one program serves
        // every observer set. The full delay descriptor participates because it changes the
        // emitted guard; translation revision changes still clear the program cache.
        const key = JSON.stringify([...delayLoops].sort(([left], [right]) => left - right));
        const cached = jit.directPrograms.get(key);
        if (cached) {
          jit.direct = cached;
          jit.directRevision = jit.revision;
        } else {
          const { states, memories, pins } = layout;
          const cache = (jit.directCache ??= compileDirectJit.createCache());
          const program = compileDirectJit(
            instructions,
            {
              states,
              memories,
              pins,
              pc: { name: jit.options.pc, index: states.get(jit.options.pc)! },
              host: true,
              split: true,
              shardSize: DIRECT_SHARD_SIZE,
              delayLoops,
            },
            cache,
          );
          jit.directRevision = jit.revision;
          jit.directMisses.clear();
          const stats = directStats(jit);

          stats.directShards = program?.shards ?? 0;
          if (program) stats.directCompiles++;
          const barrier = directBarriers(jit);
          barrier.stateIndex = states;
          barrier.memoryIndex = memories;
          const stateMaskWords = Math.ceil(layout.stateNames.length / 32);
          const memoryMaskWords = Math.ceil(layout.memoryNames.length / 32);
          if (barrier.stateMask.length !== stateMaskWords)
            barrier.stateMask = new Int32Array(stateMaskWords);
          if (barrier.memoryMask.length !== memoryMaskWords)
            barrier.memoryMask = new Int32Array(memoryMaskWords);
          syncDirectBarriers(jit);
          jit.direct = program
            ? {
                program,
                pcs: new Set(program.pcs),
                frame: createDirectFrame(board, jit, layout, program, barrier),
              }
            : undefined;
          // A declined program must not be cached, or the key would keep answering `undefined`.
          if (!jit.direct) jit.directPrograms.delete(key);
          // The key no longer carries the guard set, so one program covers every observer set:
          // the eight-slot cap (and its eviction churn) has nothing left to bound.
          else jit.directPrograms.set(key, jit.direct);
        }
      }
    }
    if (!jit.direct) return false;
  }
  const direct = jit.direct!;
  const frame = direct.frame as RuntimeDirectFrame;
  const layout = jit.directLayout!;
  for (;;) {
    if (pending) frame.stopAfterInstruction = true;
    frame.time = board.time;
    // The frame starts clean and flushDirect clears both banks, including the fault path.
    const start = board.time;
    let reason: ReturnType<DirectJitProgram['run']>;
    let wrote: boolean;
    const stats = directStats(jit);
    stats.directCalls++;
    try {
      // Resource barriers exclude intermediate observers; real events retain exact deadlines.
      reason = direct.program.run(frame, Math.min(board.executionEnd, board.events.time));
    } finally {
      wrote = flushDirect(board, instance, layout, frame);
    }
    // A fallback with no flushed slot and no elapsed time did not execute anything; the cached
    // entry PC can safely be interpreted. A zero-duration block can still write state/PC before
    // the dispatcher rejects the next uncompiled PC: `wrote` records that prefix, so the caller
    // must re-read the flushed PC instead of replaying the old one.
    if (frame.boundarySettled) frame.boundarySettled = false;
    else if (reason !== 'fallback' || wrote || board.time !== start) board.boundary();
    if (reason === 'fallback') {
      const nextPc = finite(instance.states.get(jit.options.pc), 'pc');
      // Polling PCs are deliberately absent from direct programs. Reaching one is a normal
      // shard boundary, not a failed direct dispatch, so it must neither compound fallback
      // statistics nor poison the next interpreter attempt for this PC.
      const polling = effectivePolling(jit).has(nextPc) || jit.cache.get(nextPc)?.polling;
      if (!polling) {
        stats.directFallbacks++;
        jit.directSkip = nextPc;
      }
      if (!wrote && board.time === start && board.time < board.executionEnd) return false;
    } else if (reason === 'stopped') {
      stats.directStopped++;
      jit.stopped = true;
      return true;
    } else if (reason === 'invalidated') {
      frame.stopAfterInstruction = false;
      // An electrical publication or a resumed suffix can return "invalidated" without
      // invalidating any code. An append-only revision must still honour the rebuild stride.
      // Primary code writes / metadata changes explicitly reset the program revision.
      if (jit.directProgramRevision === -1 && frame.resume === 0) {
        jit.direct = undefined;
        jit.directRevision = -1;
      }
    } else stats.directDeadlines++;
    // Publish and settle the whole boundary first. Without intervening scheduler work,
    // an already-started suffix can resume at its wake time without a queue round trip.
    // A metadata provider must still be checked by runJit before resumption.
    if (frame.resume) {
      const wake = Math.max(frame.due, board.time);
      if (jit.metadata === undefined && board.canContinueDirect(jit, wake)) {
        board.time = wake;
        board.current = instance;
        pending = true;
        continue;
      }
      if (wake > board.time) {
        board.events.push(wake, () => board.queueJit(jit));
        return true;
      }
    }
    board.queueJit(jit);
    return true;
  }
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
  board.waitingJits.add(jit);
  const token = ++jit.pollingToken;

  board.boundary();
  if (duration === 0 || advance === undefined) return;
  const due = time(board.time + duration);

  board.events.push(due, () => {
    if (token !== jit.pollingToken || !jit.active || jit.stopped || !board.waitingJits.has(jit))
      return;
    const pending = jit.dependencies;

    jit.pollingWait = false;
    delete jit.dependencies;
    board.waitingJits.delete(jit);
    jit.pollingToken++;
    board.current = jit.instance;
    // An external event won the race at the same timestamp. Re-evaluate the guest rather
    // than applying a device step against a configuration that has already changed.
    if (!jit.instance.dependenciesCurrent(pending)) {
      board.queueJit(jit);
      return;
    }
    jit.instance.syncCall(advance, [duration]);
    board.boundary();
    board.queueJit(jit);
  });
}

function jitSignal(board: JitRuntimeHost, jit: Jit, signal: ExecutionSignal): boolean {
  if (signal.kind === 'elapse') {
    const duration = time(signal.duration);
    if (duration === 0) return false;
    const due = time(board.time + duration);
    board.events.push(due, () => board.queueJit(jit));
    board.boundary();
    return true;
  }
  if (signal.kind === 'waitUntil') {
    const checked = jit.instance.evaluate(() => jit.instance.syncCall(signal.predicate));
    if (checked.value === true) return false;
    jit.predicate = signal.predicate;
    jit.pollingWait = false;
    jit.dependencies = checked.dependencies;
    board.waitingJits.add(jit);
    board.boundary();
    return true;
  }
  if (signal.kind === 'stop') {
    jit.stopped = true;
    jit.execution = undefined;
    board.boundary();
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
    board.boundary();
    if (duration === 0) board.queueJit(jit);
    else
      board.events.push(time(board.time + duration), () => {
        if (!jit.active || jit.stopped) return;
        if (dependencies && jit.instance.dependenciesCurrent(dependencies)) {
          jit.dependencies = dependencies;
          jit.pollingWait = true;
          jit.pollingPeriod = duration;
          jit.pollingOrigin = board.time;
          board.waitingJits.add(jit);
        } else board.queueJit(jit);
      });
    return true;
  }
  throw new TypeError('Invalid JIT suspension');
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
    runDirect(board, jit);
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
      if (!hookPending && board.jits.length === 1 && runDirect(board, jit, hookReads)) return;
    }
    let instruction = jit.cache.get(pc);
    if (!instruction) {
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
          if (!valid)
            throw board.error('OBJECT_DISPOSED', 'Translation view expired', jit.instance);
        });
        const result = jit.options.translate(
          Object.freeze({
            pc,
            code: code as import('../types').BorrowedBytes,
            codeBase: codeRegion?.base ?? 0,
            codeVersion: jit.instance.codeVersion(codeMemory),
          }),
          createJitBlockBuilder({ device: jit.instance.entry.model }),
        );
        acceptSync(result);
        const block = validateBoundBlockIR(result, jit.instance.entry.model);
        if (block.instructions[0]?.pc !== pc)
          throw new TypeError('Translated first pc does not match');
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
        // An overlapping translation can replace a covered body instead of just adding PCs.
        // It runs only after any direct continuation has drained, so discard that program now.
        if (instructions.some((entry) => jit.direct?.pcs.has(entry.pc))) {
          jit.direct = undefined;
          jit.directPrograms.clear();
        }
        // Match the first instruction when a block contains a repeated PC.
        for (let index = instructions.length - 1; index >= 0; index--) {
          const entry = instructions[index]!;
          jit.cache.set(entry.pc, entry);
          jit.cacheMemories.add(entry.codeRegion?.memory ?? jit.options.code);
        }
        // A block may legally span multiple PCs. Every entry gets its own logical region;
        // direct programs only admit primary/fallback entries. The start region only supplies
        // the translate-time byte view and codeVersion.
        if (
          instructions.some(
            (entry) =>
              entry.codeRegion === undefined || entry.codeRegion.memory === jit.options.code,
          )
        )
          jit.revision++;
        jit.directSkip = undefined;
        instruction = instructions[0]!;
      } catch (cause) {
        throw board.wrap(cause, 'JIT_FAILED', 'translate', jit.instance);
      } finally {
        valid = false;
        board.phase = prior;
      }
    }
    jit.currentPc = pc;
    jit.automaticPolling =
      board.execution === 'throughput' &&
      board.jits.length === 1 &&
      instruction.polling &&
      !hookPending &&
      (!hook || hookReads !== undefined);
    jit.pollReads = hookReads;
    jit.instance.host.write(jit.options.pc, instruction.nextPc);
    jit.execution = instruction.execute(jit.instance.host);
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
      board.boundary();
      board.queueJit(jit);
      return;
    }
    if (jitSignal(board, jit, step.value)) return;
  }
}
