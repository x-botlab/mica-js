import {
  compileDirectJit,
  type CompiledBody,
  type DirectJitArtifactCacheStats,
  type DirectJitBinding,
  type DirectJitFrame,
  type DirectJitHost,
  type DirectJitInstruction,
  type DirectJitSession,
  type DirectJitSessionStats,
  type DirectJitShareRejectedStats,
  type DirectJitTiming,
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
  JitLoopCandidate,
  JitTranslationDependency,
  RuntimeDiagnosticCode,
  RuntimePhase,
  SimulationError,
} from '../types';
import { bytesView, dataObject, finite } from '../values';

/** Large programs dispatch through shards; small ones stay on the faster monolithic form. */
const DIRECT_SHARD_SIZE = 32;
/**
 * One process/module-wide compiler artifact cache. Every session in this module instance
 * reuses instruction templates and shard factories across boards with equal bindings.
 */
const sharedDirectArtifacts = compileDirectJit.createArtifactCache();
/** Last process-wide artifact counters observed by each JIT after a session commit. */
const directArtifactSnapshots = new WeakMap<Jit, DirectJitArtifactCacheStats>();
/** False when a declared quiet guard cannot be resolved; marked routes must not enroll. */
const directTimingEligible = new WeakMap<Jit, boolean>();

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

/** Runtime-side classifications of a rejected `markDirectBodyShareable` call. */
export interface DirectShareMarkRejectedStats {
  /** The marked PC is not an instruction entry of the returned block. */
  unknownPc: number;
  /** The same block marked one instruction entry more than once. */
  duplicate: number;
  /** The PC is not a non-negative safe integer. */
  invalidPc: number;
  /** The byte length is not a positive safe integer. */
  invalidLength: number;
  /** The byte range leaves the start region or the borrowed view. */
  outsideRegion: number;
  /** The entry was fetched through a different logical window than the start PC. */
  crossView: number;
  /** The entry has no code region and would be fetched by the service-PC fallback. */
  service: number;
  /** The entry is polling or does not use the primary code memory. */
  notAdmitted: number;
}
/** Runtime-side classifications of a rejected `markDirectSpan` call. */
export interface DirectSpanMarkRejectedStats {
  /** The PC or instruction count is not a valid integer in range. */
  invalid: number;
  /** The marked PC is not an instruction entry of the returned block. */
  unknownPc: number;
  /** The same block marked one span head more than once. */
  duplicate: number;
  /** Members are missing, repeated or their `nextPc` does not join the next member. */
  discontinuous: number;
  /** A member is polling, belongs to another code memory or is a service fallback. */
  notAdmitted: number;
  /** A loop mark names the same entry. */
  conflict: number;
}
/** Runtime-side classifications of a rejected `markDirectLoop` call. */
export interface DirectLoopMarkRejectedStats {
  /** The marker or candidate shape is not a plain supported object. */
  invalid: number;
  /** The marked PC is not an instruction entry of the returned block. */
  unknownPc: number;
  /** The same block marked one loop head more than once. */
  duplicate: number;
  /** The instruction is polling or belongs to another code memory. */
  notAdmitted: number;
  /** The loop head has an effective delay declaration. */
  delayConflict: number;
  /** A span mark names the same entry. */
  conflict: number;
  /** The counter memory or synthesized address is out of range. */
  address: number;
}
/** Runtime-side classifications of a rejected `markTranslationDependencies` call. */
export interface DirectDependencyMarkRejectedStats {
  /** A range is not a pair of non-negative safe integers. */
  invalidRange: number;
  /** `offset + length` leaves the borrowed translation view. */
  outsideView: number;
}

/** Mutable copy of the compiler's cumulative rejection counters. */
export type DirectShareRejectedStats = {
  -readonly [K in keyof DirectJitShareRejectedStats]: number;
};

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
  /** Successfully completed generic instructions counted toward two-tier promotion. */
  directPromotionGenericRuns: number;
  /** PCs whose promotion counter reached `directTier.promoteAfter`. */
  directPromotions: number;
  /** Direct admission attempts that stayed generic because the PC was not promoted. */
  directTierFallbacks: number;
  /** Promoted PCs that currently own a dispatchable route in the active session. */
  directPromotedRoutes: number;
  /** Promotion records cleared by primary code writes or overlapping IR replacement. */
  directPromotionResets: number;
  /** Cumulative generated characters of emitted instruction bodies. */
  directBodyBytes: number;
  /** Instruction templates reused from the shared artifact cache by this JIT's sessions. */
  directArtifactInstructionHits: number;
  /** Instruction templates this JIT's sessions had to emit after an artifact miss. */
  directArtifactInstructionMisses: number;
  /** Process-wide shard sources reused from the artifact cache, observed as JIT deltas. */
  directArtifactShardSourceHits: number;
  /** Process-wide shard factories compiled after an artifact miss, observed as JIT deltas. */
  directArtifactFactoryCompiles: number;
  /** Process-wide shard factories reused from the artifact cache, observed as JIT deltas. */
  directArtifactFactoryReuses: number;
  /** Current instruction + shard entries in the process-wide artifact cache. */
  directArtifactEntries: number;
  /** Cumulative generated characters of emitted shard functions. */
  directShardBytes: number;
  /** Cumulative generated characters of fixed dispatchers. */
  directDispatcherBytes: number;
  /** Cumulative generated characters of synchronous helper functions. */
  directHelperBytes: number;
  /** `markDirectBodyShareable` callbacks received while a translation is in progress. */
  directShareCallbacks: number;
  /** Marked entries that passed runtime validation across all translations. */
  directShareCandidates: number;
  /** Equivalence groups currently backed by a shared body in the active session. */
  directShareGroups: number;
  /** Current routes that point at a shared body. */
  directSharedRoutes: number;
  /** Cumulative shared step/resume bodies emitted across all sessions. */
  directSharedBodies: number;
  /** Cumulative generated characters of emitted shared bodies. */
  directSharedBytes: number;
  /** Cumulative marked routes that reused an already emitted shared body. */
  directShareReusedBodies: number;
  /** Cumulative route installs that selected a shared body. */
  directShareReusedRoutes: number;
  /** Compiler-side classifications for marked entries that stayed independent. */
  directShareRejected: DirectShareRejectedStats;
  /** Runtime-side classifications for rejected marks; the entry still executes normally. */
  directShareMarkRejected: DirectShareMarkRejectedStats;
  /** Cumulative span routes installed by the compiler. */
  directSpans: number;
  /** Fused span executions observed through per-frame metrics. */
  directSpanRuns: number;
  /** Cumulative span markers rejected by structural or timing proof. */
  directSpanRejected: number;
  /** Cumulative loop routes installed by the compiler. */
  directLoops: number;
  /** Rounds folded by installed loop routes, observed through per-frame metrics. */
  directLoopRounds: number;
  /** Cumulative loop markers rejected by structural or timing proof. */
  directLoopRejected: number;
  /** `markDirectSpan` callbacks received while a translation is in progress. */
  directSpanCallbacks: number;
  /** Span marks that passed runtime validation across all translations. */
  directSpanCandidates: number;
  /** `markDirectLoop` callbacks received while a translation is in progress. */
  directLoopCallbacks: number;
  /** Loop marks that passed runtime validation across all translations. */
  directLoopCandidates: number;
  /** Runtime-side classifications for rejected span marks. */
  directSpanMarkRejected: DirectSpanMarkRejectedStats;
  /** Runtime-side classifications for rejected loop marks. */
  directLoopMarkRejected: DirectLoopMarkRejectedStats;
  /** Runtime-side classifications for rejected dependency ranges. */
  directDependencyMarkRejected: DirectDependencyMarkRejectedStats;
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
    directPromotionGenericRuns: 0,
    directPromotions: 0,
    directTierFallbacks: 0,
    directPromotedRoutes: 0,
    directPromotionResets: 0,
    directBodyBytes: 0,
    directArtifactInstructionHits: 0,
    directArtifactInstructionMisses: 0,
    directArtifactShardSourceHits: 0,
    directArtifactFactoryCompiles: 0,
    directArtifactFactoryReuses: 0,
    directArtifactEntries: 0,
    directShardBytes: 0,
    directDispatcherBytes: 0,
    directHelperBytes: 0,
    directShareCallbacks: 0,
    directShareCandidates: 0,
    directShareGroups: 0,
    directSharedRoutes: 0,
    directSharedBodies: 0,
    directSharedBytes: 0,
    directShareReusedBodies: 0,
    directShareReusedRoutes: 0,
    directShareRejected: {
      missing: 0,
      invalid: 0,
      single: 0,
      ir: 0,
      delay: 0,
      isolated: 0,
      context: 0,
    },
    directShareMarkRejected: {
      unknownPc: 0,
      duplicate: 0,
      invalidPc: 0,
      invalidLength: 0,
      outsideRegion: 0,
      crossView: 0,
      service: 0,
      notAdmitted: 0,
    },
    directSpans: 0,
    directSpanRuns: 0,
    directSpanRejected: 0,
    directLoops: 0,
    directLoopRounds: 0,
    directLoopRejected: 0,
    directSpanCallbacks: 0,
    directSpanCandidates: 0,
    directLoopCallbacks: 0,
    directLoopCandidates: 0,
    directSpanMarkRejected: {
      invalid: 0,
      unknownPc: 0,
      duplicate: 0,
      discontinuous: 0,
      notAdmitted: 0,
      conflict: 0,
    },
    directLoopMarkRejected: {
      invalid: 0,
      unknownPc: 0,
      duplicate: 0,
      notAdmitted: 0,
      delayConflict: 0,
      conflict: 0,
      address: 0,
    },
    directDependencyMarkRejected: {
      invalidRange: 0,
      outsideView: 0,
    },
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
  stats.directArtifactInstructionHits +=
    next.artifactInstructionHits - (base?.artifactInstructionHits ?? 0);
  stats.directArtifactInstructionMisses +=
    next.artifactInstructionMisses - (base?.artifactInstructionMisses ?? 0);
  stats.directShardBytes += next.shardBytes - (base?.shardBytes ?? 0);
  stats.directDispatcherBytes += next.dispatcherBytes - (base?.dispatcherBytes ?? 0);
  stats.directHelperBytes += next.helperBytes - (base?.helperBytes ?? 0);
  stats.directShareGroups = next.shareGroups;
  stats.directSharedRoutes = next.sharedRoutes;
  stats.directSharedBodies += next.sharedBodies - (base?.sharedBodies ?? 0);
  stats.directSharedBytes += next.sharedBytes - (base?.sharedBytes ?? 0);
  stats.directShareReusedBodies += next.shareReusedBodies - (base?.shareReusedBodies ?? 0);
  stats.directShareReusedRoutes += next.shareReusedRoutes - (base?.shareReusedRoutes ?? 0);
  stats.directShareRejected.missing +=
    next.shareRejected.missing - (base?.shareRejected.missing ?? 0);
  stats.directShareRejected.invalid +=
    next.shareRejected.invalid - (base?.shareRejected.invalid ?? 0);
  stats.directShareRejected.single += next.shareRejected.single - (base?.shareRejected.single ?? 0);
  stats.directShareRejected.ir += next.shareRejected.ir - (base?.shareRejected.ir ?? 0);
  stats.directShareRejected.delay += next.shareRejected.delay - (base?.shareRejected.delay ?? 0);
  stats.directShareRejected.isolated +=
    next.shareRejected.isolated - (base?.shareRejected.isolated ?? 0);
  stats.directShareRejected.context +=
    next.shareRejected.context - (base?.shareRejected.context ?? 0);
  stats.directSpans += next.spansInstalled - (base?.spansInstalled ?? 0);
  stats.directSpanRejected += next.spansRejected - (base?.spansRejected ?? 0);
  stats.directLoops += next.loopsInstalled - (base?.loopsInstalled ?? 0);
  stats.directLoopRejected += next.loopsRejected - (base?.loopsRejected ?? 0);
  // Shard/factory counters are process-wide. Attribute the delta since this JIT last
  // observed the shared cache; `directArtifactEntries` publishes the current gauge.
  const artifacts = compileDirectJit.artifactCacheStats(sharedDirectArtifacts);
  const artifactsBase = directArtifactSnapshots.get(jit);
  stats.directArtifactShardSourceHits +=
    artifacts.reusedShardSources - (artifactsBase?.reusedShardSources ?? 0);
  stats.directArtifactFactoryCompiles +=
    artifacts.createdFactories - (artifactsBase?.createdFactories ?? 0);
  stats.directArtifactFactoryReuses +=
    artifacts.reusedFactories - (artifactsBase?.reusedFactories ?? 0);
  stats.directArtifactEntries = artifacts.instructionEntries + artifacts.shardEntries;
  directArtifactSnapshots.set(jit, artifacts);
  stats.directShards = next.shards;
  stats.directRoutes = next.routes;
  let promotedRoutes = 0;
  for (const [pc, promotion] of jit.promotions)
    if (promotion.state === 'promoted' && session.has(pc)) promotedRoutes++;
  stats.directPromotedRoutes = promotedRoutes;
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
    stats.directPromotedRoutes = 0;
    stats.directShareGroups = 0;
    stats.directSharedRoutes = 0;
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
  clearPromotions(jit, false);
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

/**
 * Two-tier admission. Without `directTier` every admitted entry keeps the immediate-Direct
 * policy; with a tier only a promoted entry whose exact translation identity still matches
 * may enter a session.
 */
function directTierAdmitted(jit: Jit, instruction: JitInstruction | undefined): boolean {
  if (jit.options.directTier === undefined) return true;
  if (instruction === undefined) return false;
  const promotion = jit.promotions.get(instruction.pc);
  return (
    promotion !== undefined &&
    promotion.state === 'promoted' &&
    promotion.body === instruction.body &&
    promotion.nextPc === instruction.nextPc &&
    promotion.codeVersion === instruction.codeVersion
  );
}

/** Revoke one Direct route after its promotion identity changed; suspended suffixes finish. */
function revokeDirectRoute(jit: Jit, pc: number): void {
  const direct = jit.direct;
  if (direct === undefined || jit.directStale || direct.frame.resume !== 0) return;
  if (!direct.session.has(pc)) return;
  direct.session.remove([pc]);
  syncDirectSessionStats(jit, direct.session);
}

/**
 * Clear every promotion record of this instance. `reset` counts the records as invalidated by
 * primary code writes or IR replacement; explicit disposal clears them silently.
 */
export function clearPromotions(jit: Jit, reset = true): void {
  if (jit.promotions.size === 0) return;
  const stats = directJitStats(jit);
  if (stats !== undefined) {
    if (reset) stats.directPromotionResets += jit.promotions.size;
    stats.directPromotedRoutes = 0;
  }
  jit.promotions.clear();
}

/**
 * Count one successfully completed generic instruction. Only the shared generic body calls
 * this, after its final suffix and after re-checking that the executed translation is still
 * the cached one. Polling, rejected and stale paths never reach the threshold.
 */
function recordDirectPromotion(jit: Jit, pc: number, instruction: JitInstruction): void {
  const tier = jit.options.directTier;
  if (tier === undefined) return;
  const current = jit.cache.get(pc);
  if (
    current === undefined ||
    current.body !== instruction.body ||
    current.nextPc !== instruction.nextPc ||
    current.codeVersion !== instruction.codeVersion ||
    !directAdmitted(jit, current)
  )
    return;
  let promotion = jit.promotions.get(pc);
  if (
    promotion !== undefined &&
    (promotion.body !== current.body ||
      promotion.nextPc !== current.nextPc ||
      promotion.codeVersion !== current.codeVersion)
  ) {
    // Defensive: translation-time reconciliation normally clears this before any completion.
    jit.promotions.delete(pc);
    revokeDirectRoute(jit, pc);
    promotion = undefined;
  }
  const stats = directStats(jit);
  if (promotion === undefined) {
    promotion = {
      count: 0,
      state: 'generic',
      body: current.body,
      nextPc: current.nextPc,
      codeVersion: current.codeVersion,
    };
    jit.promotions.set(pc, promotion);
  } else if (promotion.state === 'promoted') return;
  stats.directPromotionGenericRuns++;
  if (promotion.count < tier.promoteAfter) {
    promotion.count = Math.min(promotion.count + 1, Number.MAX_SAFE_INTEGER);
    if (promotion.count >= tier.promoteAfter) {
      promotion.state = 'promoted';
      stats.directPromotions++;
    }
  }
}

/**
 * Reconcile promotion state with an overlapping translation. Identical body/nextPc/version
 * keeps the counter; any other replacement clears that PC and revokes its old route.
 */
function reconcilePromotions(
  jit: Jit,
  instructions: readonly JitInstruction[],
  oldEntries: ReadonlyMap<number, JitInstruction>,
): void {
  if (jit.options.directTier === undefined || jit.promotions.size === 0) return;
  const stats = directJitStats(jit);
  for (const instruction of instructions) {
    if (!oldEntries.has(instruction.pc)) continue;
    const promotion = jit.promotions.get(instruction.pc);
    if (promotion === undefined) continue;
    if (
      promotion.body === instruction.body &&
      promotion.nextPc === instruction.nextPc &&
      promotion.codeVersion === instruction.codeVersion
    )
      continue;
    jit.promotions.delete(instruction.pc);
    if (stats !== undefined) stats.directPromotionResets++;
    revokeDirectRoute(jit, instruction.pc);
  }
}

function directInstruction(jit: Jit, instruction: JitInstruction): DirectJitInstruction {
  const timingEligible = directTimingEligible.get(jit) !== false;
  return {
    pc: instruction.pc,
    nextPc: instruction.nextPc,
    body: instruction.body,
    // Sharing is opt-in per registration; a candidate collected in an earlier translation
    // of the same option state is only forwarded by a sharing session.
    ...(jit.options.shareDirectBodies === true && instruction.share !== undefined
      ? { share: instruction.share }
      : {}),
    ...(!timingEligible
      ? {}
      : {
          ...(instruction.span === undefined ? {} : { span: instruction.span }),
          ...(instruction.loop === undefined ? {} : { loop: instruction.loop }),
        }),
  };
}

/** One `markDirectBodyShareable` call collected during a synchronous translation. */
interface DirectShareMark {
  readonly pc: number;
  readonly byteLength: number;
}

/**
 * Attach validated marks to their translated entries. The block itself is already committed
 * to the interpreter path, so every rejection only drops sharing for that entry; it never
 * rejects the translation. Runs once per translated block, never on the `run` hot path.
 */
function applyDirectShareMarks(
  jit: Jit,
  startRegion: JitCodeRegion | undefined,
  codeLength: number,
  instructions: JitInstruction[],
  marks: readonly DirectShareMark[],
): void {
  if (marks.length === 0) return;
  const indexByPc = new Map<number, number>();
  for (let index = 0; index < instructions.length; index++) {
    const pc = instructions[index]!.pc;
    if (!indexByPc.has(pc)) indexByPc.set(pc, index);
  }
  const stats = directStats(jit);
  const rejected = stats.directShareMarkRejected;
  const seen = new Set<number>();
  for (const { pc, byteLength } of marks) {
    if (!Number.isSafeInteger(pc) || pc < 0) {
      rejected.invalidPc++;
      continue;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
      rejected.invalidLength++;
      continue;
    }
    if (seen.has(pc)) {
      rejected.duplicate++;
      continue;
    }
    seen.add(pc);
    const index = indexByPc.get(pc);
    if (index === undefined) {
      rejected.unknownPc++;
      continue;
    }
    const instruction = instructions[index]!;
    const region = instruction.codeRegion;
    if (region === undefined) {
      rejected.service++;
      continue;
    }
    // The borrowed view was cut from the start region. An entry fetched through another
    // window is not physically comparable even when both windows name the same storage.
    if (startRegion === undefined || region !== startRegion) {
      rejected.crossView++;
      continue;
    }
    const offset = pc - region.base;
    if (
      offset < 0 ||
      !Number.isSafeInteger(offset + byteLength) ||
      offset + byteLength > region.size ||
      offset + byteLength > codeLength
    ) {
      rejected.outsideRegion++;
      continue;
    }
    if (!directAdmitted(jit, instruction)) {
      rejected.notAdmitted++;
      continue;
    }
    instructions[index] = {
      ...instruction,
      share: Object.freeze({
        storage: region.memory,
        codeVersion: instruction.codeVersion,
        offset,
        byteLength,
      }),
    };
    stats.directShareCandidates++;
  }
}

/** One `markDirectSpan` call collected during a synchronous translation. */
interface DirectSpanMark {
  readonly pc: number;
  readonly instructionCount: number;
}

/** Normalised loop marker; address ranges are validated against the instance afterwards. */
type CapturedLoopCandidate =
  | { readonly kind: 'spin' }
  | {
      readonly kind: 'decrement8';
      readonly memory: unknown;
      readonly address:
        | { readonly kind: 'constant'; readonly offset: unknown }
        | {
            readonly kind: 'maskedByte';
            readonly memory: unknown;
            readonly offset: unknown;
            readonly mask: unknown;
            readonly bits: unknown;
          };
    };

/** One `markDirectLoop` call; `candidate` is undefined when its shape was rejected. */
interface DirectLoopMark {
  readonly pc: number;
  readonly candidate: CapturedLoopCandidate | undefined;
}

/**
 * Copy a loop candidate while the translate callback is on the stack. Later mutation of the
 * caller's object cannot change what this translation validated.
 */
function captureLoopCandidate(value: unknown): CapturedLoopCandidate | undefined {
  try {
    dataObject(value);
    const kind = (value as { readonly kind?: unknown }).kind;
    if (kind === 'spin') return Object.freeze({ kind: 'spin' as const });
    if (kind !== 'decrement8') return undefined;
    dataObject(value, ['kind', 'memory', 'address']);
    const record = value as { readonly memory: unknown; readonly address: unknown };
    if (typeof record.memory !== 'string' || record.memory.length === 0) return undefined;
    dataObject(record.address);
    const address = record.address as { readonly kind?: unknown };
    if (address.kind === 'constant') {
      dataObject(address, ['kind', 'offset']);
      const offset = (address as { readonly offset: unknown }).offset;
      if (typeof offset !== 'number') return undefined;
      return Object.freeze({
        kind: 'decrement8' as const,
        memory: record.memory,
        address: Object.freeze({ kind: 'constant' as const, offset }),
      });
    }
    if (address.kind !== 'maskedByte') return undefined;
    dataObject(address, ['kind', 'memory', 'offset', 'mask', 'bits']);
    const masked = address as {
      readonly memory: unknown;
      readonly offset: unknown;
      readonly mask: unknown;
      readonly bits: unknown;
    };
    if (
      typeof masked.memory !== 'string' ||
      masked.memory.length === 0 ||
      typeof masked.offset !== 'number' ||
      typeof masked.mask !== 'number' ||
      typeof masked.bits !== 'number'
    )
      return undefined;
    return Object.freeze({
      kind: 'decrement8' as const,
      memory: record.memory,
      address: Object.freeze({
        kind: 'maskedByte' as const,
        memory: masked.memory,
        offset: masked.offset,
        mask: masked.mask,
        bits: masked.bits,
      }),
    });
  } catch {
    return undefined;
  }
}

/** Primary memory and the ordinary Direct admission shared by span members. */
function directPrimaryAdmitted(jit: Jit, instruction: JitInstruction): boolean {
  const region = instruction.codeRegion;
  return (
    region !== undefined && region.memory === jit.options.code && directAdmitted(jit, instruction)
  );
}

/** Validate a decrement8 address against the instance memories; undefined means rejected. */
function directLoopCandidate(
  jit: Jit,
  candidate: CapturedLoopCandidate,
): JitLoopCandidate | undefined {
  if (candidate.kind === 'spin') return Object.freeze({ kind: 'spin' });
  const memory = candidate.memory;
  if (typeof memory !== 'string' || memory.length === 0) return undefined;
  // A counter bank that is also executable would turn folding writes into code changes.
  if (jit.codeRegions.some((region) => region.memory === memory)) return undefined;
  const counter = jit.instance.memories.get(memory);
  if (counter === undefined) return undefined;
  const address = candidate.address;
  if (address.kind === 'constant') {
    const offset = address.offset;
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      (offset as number) >= counter.length
    )
      return undefined;
    return Object.freeze({
      kind: 'decrement8',
      memory,
      address: Object.freeze({ kind: 'constant', offset: offset as number }),
    });
  }
  const selectorMemory = address.memory;
  const offset = address.offset;
  const mask = address.mask;
  const bits = address.bits;
  if (typeof selectorMemory !== 'string' || selectorMemory.length === 0) return undefined;
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(mask) ||
    (mask as number) < 0 ||
    (mask as number) > 255 ||
    !Number.isSafeInteger(bits) ||
    (bits as number) < 0 ||
    (bits as number) > 255
  )
    return undefined;
  const selector = jit.instance.memories.get(selectorMemory);
  if (selector === undefined || (offset as number) >= selector.length) return undefined;
  // A selector that is also executable would make the synthesized address generation-dependent.
  if (jit.codeRegions.some((region) => region.memory === selectorMemory)) return undefined;
  if (((mask as number) | (bits as number)) >= counter.length) return undefined;
  for (let value = 0; value < 256; value++) {
    const target = ((value & (mask as number)) | (bits as number)) >>> 0;
    if (target >= counter.length) return undefined;
  }
  return Object.freeze({
    kind: 'decrement8',
    memory,
    address: Object.freeze({
      kind: 'maskedByte',
      memory: selectorMemory,
      offset: offset as number,
      mask: mask as number,
      bits: bits as number,
    }),
  });
}

/**
 * Attach validated Direct timing marks to their translated entries. Rejections only drop the
 * optimization: the block itself is already committed to the ordinary interpreter path.
 */
function applyDirectTimingMarks(
  jit: Jit,
  instructions: JitInstruction[],
  spanMarks: readonly DirectSpanMark[],
  loopMarks: readonly DirectLoopMark[],
): void {
  if (spanMarks.length === 0 && loopMarks.length === 0) return;
  const stats = directStats(jit);
  const indexByPc = new Map<number, number>();
  for (let index = 0; index < instructions.length; index++) {
    const pc = instructions[index]!.pc;
    if (!indexByPc.has(pc)) indexByPc.set(pc, index);
  }
  const spanPcs = new Set<number>();
  const loopPcs = new Set<number>();
  for (const mark of spanMarks)
    if (
      Number.isSafeInteger(mark.pc) &&
      mark.pc >= 0 &&
      Number.isInteger(mark.instructionCount) &&
      mark.instructionCount >= 2 &&
      mark.instructionCount <= 8
    )
      spanPcs.add(mark.pc);
  for (const mark of loopMarks)
    if (Number.isSafeInteger(mark.pc) && mark.pc >= 0) loopPcs.add(mark.pc);

  const spanRejected = stats.directSpanMarkRejected;
  const seenSpans = new Set<number>();
  for (const mark of spanMarks) {
    const { pc, instructionCount } = mark;
    if (
      !Number.isSafeInteger(pc) ||
      pc < 0 ||
      !Number.isInteger(instructionCount) ||
      instructionCount < 2 ||
      instructionCount > 8
    ) {
      spanRejected.invalid++;
      continue;
    }
    if (seenSpans.has(pc)) {
      spanRejected.duplicate++;
      continue;
    }
    seenSpans.add(pc);
    if (loopPcs.has(pc)) {
      spanRejected.conflict++;
      continue;
    }
    const index = indexByPc.get(pc);
    if (index === undefined) {
      spanRejected.unknownPc++;
      continue;
    }
    if (index + instructionCount > instructions.length) {
      spanRejected.discontinuous++;
      continue;
    }
    const members = instructions.slice(index, index + instructionCount);
    const memberPcs = new Set<number>();
    let continuous = true;
    for (let member = 0; member < members.length; member++) {
      const current = members[member]!;
      if (memberPcs.has(current.pc)) {
        continuous = false;
        break;
      }
      memberPcs.add(current.pc);
      const next = members[member + 1];
      if (next !== undefined && current.nextPc !== next.pc) {
        continuous = false;
        break;
      }
    }
    if (!continuous) {
      spanRejected.discontinuous++;
      continue;
    }
    if (members.some((member) => !directPrimaryAdmitted(jit, member))) {
      spanRejected.notAdmitted++;
      continue;
    }
    const pcs = Object.freeze(members.map((member) => member.pc));
    instructions[index] = {
      ...instructions[index]!,
      span: Object.freeze({ pcs }),
    };
    stats.directSpanCandidates++;
  }

  const loopRejected = stats.directLoopMarkRejected;
  const seenLoops = new Set<number>();
  for (const mark of loopMarks) {
    const { pc, candidate } = mark;
    if (!Number.isSafeInteger(pc) || pc < 0) {
      loopRejected.invalid++;
      continue;
    }
    if (seenLoops.has(pc)) {
      loopRejected.duplicate++;
      continue;
    }
    seenLoops.add(pc);
    if (spanPcs.has(pc)) {
      loopRejected.conflict++;
      continue;
    }
    const index = indexByPc.get(pc);
    if (index === undefined) {
      loopRejected.unknownPc++;
      continue;
    }
    const instruction = instructions[index]!;
    if (!directAdmitted(jit, instruction)) {
      loopRejected.notAdmitted++;
      continue;
    }
    if (effectiveDelays(jit).has(pc)) {
      loopRejected.delayConflict++;
      continue;
    }
    if (candidate === undefined) {
      loopRejected.invalid++;
      continue;
    }
    const loop = directLoopCandidate(jit, candidate);
    if (loop === undefined) {
      loopRejected.address++;
      continue;
    }
    instructions[index] = {
      ...instruction,
      loop,
    };
    stats.directLoopCandidates++;
  }
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
  let functions = jit.functions;
  let directTiming: DirectJitTiming | undefined;
  let timingEligible = true;
  const option = jit.options.directTiming;
  if (option !== undefined) {
    let blocked = option.blocked;
    if (blocked !== undefined) {
      const declaration = functions?.get(blocked) ?? jit.instance.declarations.get(blocked);
      if (
        declaration?.kind !== 'function' ||
        declaration.pure !== true ||
        declaration.params.length !== 0 ||
        declaration.returns?.kind !== 'bool'
      ) {
        // Attach validated the declaration; an appended function table may still disagree.
        // Fail closed: keep marked spans/loops out of this session instead of dropping the guard.
        blocked = undefined;
        timingEligible = false;
      } else if (functions?.get(blocked) === undefined) {
        // `jit.functions` only owns appended JIT functions. Keep its identity untouched and
        // add the base-model guard to a private map for this binding.
        const extended = new Map(functions ?? []);
        extended.set(blocked, declaration);
        functions = extended;
      }
    }
    const service = option.service;
    if (service !== undefined) {
      const elapsed = states.get(service.elapsed);
      const deadline = states.get(service.deadline);
      // A declared guard that cannot be resolved fails closed: omit `directTiming` entirely
      // so marked spans/loops stay unenrolled instead of running without the quiet guard.
      if (
        (option.blocked === undefined || blocked !== undefined) &&
        elapsed !== undefined &&
        deadline !== undefined
      ) {
        directTiming = {
          elapsed,
          deadline,
          ...(blocked === undefined ? {} : { blocked }),
        };
      }
    }
  }
  const memoryLengths = new Map<string, number>();
  for (const name of layout.memoryNames) memoryLengths.set(name, jit.instance.memory(name).length);
  const codeMemories = new Set(jit.codeRegions.map((region) => region.memory));
  directTimingEligible.set(jit, timingEligible);
  return {
    states,
    memories,
    pins,
    pc: { name: jit.options.pc, index: states.get(jit.options.pc)! },
    host: true,
    ...(functions === undefined ? {} : { functions }),
    split: true,
    shardSize: DIRECT_SHARD_SIZE,
    delayLoops: directDelayLoops(jit, layout),
    entryBlockedStates: entry.states,
    entryBlockedMemories: entry.memories,
    blockedStates: jit.directStateGuards,
    blockedMemories: jit.directMemoryGuards,
    ...(directTiming === undefined ? {} : { directTiming }),
    memoryLengths,
    codeMemories,
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
    if (
      directAdmitted(jit, instruction) &&
      (jit.options.directTier === undefined || directTierAdmitted(jit, instruction))
    )
      admitted.push(instruction);
  // Translation callbacks may append static delay declarations for this same batch.
  direct.session.updateDelays(directDelayLoops(jit, jit.directLayout!));
  if (admitted.length) {
    direct.session.add(admitted.map((instruction) => directInstruction(jit, instruction)));
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
  const admitted: JitInstruction[] = [];
  for (const instruction of jit.cache.values())
    if (
      directAdmitted(jit, instruction) &&
      (jit.options.directTier === undefined || directTierAdmitted(jit, instruction))
    )
      admitted.push(instruction);
  // In two-tier mode a session without a promoted route could only report misses and would
  // compile nothing; leave creation to the first actual promotion.
  if (jit.options.directTier !== undefined && admitted.length === 0) return undefined;
  const layout = directLayout(jit);
  if (jit.directCacheInvalid) {
    // Bodies from the previous code generation must never resurface through `rebuildAll`.
    // A cache that never existed has nothing to clear and must not consume the write marker
    // that the first real replacement needs.
    if (jit.directCache !== undefined) compileDirectJit.clearCache(jit.directCache);
    jit.directCacheInvalid = false;
  }
  const cache = (jit.directCache ??= compileDirectJit.createCache());
  // Seed the process-wide artifact baseline before this session's first compile so the
  // JIT's counters only include work performed after it started observing the cache.
  if (!directArtifactSnapshots.has(jit))
    directArtifactSnapshots.set(jit, compileDirectJit.artifactCacheStats(sharedDirectArtifacts));
  let session: DirectJitSession | undefined;
  try {
    session = compileDirectJit.createSession(
      directBinding(jit, layout),
      cache,
      sharedDirectArtifacts,
    );
    if (admitted.length)
      session.add(admitted.map((instruction) => directInstruction(jit, instruction)));
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
    directMetrics: { spanRuns: 0, loopRounds: 0 },
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
    if (jit.options.directTier !== undefined && !directTierAdmitted(jit, jit.cache.get(pc))) {
      // The PC has not reached its promotion threshold yet. Only a translated, admitted
      // entry is an actual two-tier fallback; an untranslated PC still needs its first
      // generic turn and a polling/declined entry never reaches this gate.
      if (jit.cache.has(pc)) directStats(jit).directTierFallbacks++;
      return 'declined';
    }
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
    const metrics = frame.directMetrics;
    const beforeSpanRuns = metrics?.spanRuns ?? 0;
    const beforeLoopRounds = metrics?.loopRounds ?? 0;
    stats.directCalls++;
    try {
      // Resource barriers exclude intermediate observers; real events retain exact deadlines.
      reason = direct.session.run(frame, Math.min(board.executionEnd, board.events.time));
    } finally {
      try {
        wrote = flushDirect(board, instance, layout, frame);
      } finally {
        if (metrics !== undefined) {
          // The compiler accumulates these counters; take a delta instead of resetting them.
          stats.directSpanRuns += metrics.spanRuns - beforeSpanRuns;
          stats.directLoopRounds += metrics.loopRounds - beforeLoopRounds;
        }
      }
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
  if (jit.options.directTier !== undefined && !directTierAdmitted(jit, instruction)) return false;
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
    if (jit.options.directTier !== undefined) jit.genericInstruction = undefined;
    board.boundary('jitSignal');
    return true;
  }
  if (signal.kind === 'redirect') {
    finite(signal.pc, 'redirect target');
    const duration = time(signal.delay);
    jit.instance.host.write(jit.options.pc, signal.pc);
    jit.execution = undefined;
    if (jit.options.directTier !== undefined) jit.genericInstruction = undefined;
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
  let marking = false;
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
    // Marks are only collected while the synchronous translate callback is on the stack.
    // A later call through a retained reference sees `marking === false` and is ignored.
    const shareMarks: DirectShareMark[] | undefined =
      jit.options.shareDirectBodies === true ? [] : undefined;
    const spanMarks: DirectSpanMark[] | undefined =
      jit.options.directTiming !== undefined ? [] : undefined;
    const loopMarks: DirectLoopMark[] | undefined =
      jit.options.directTiming !== undefined ? [] : undefined;
    const dependencyMarks = jit.options.translationIdentity !== undefined;
    marking =
      shareMarks !== undefined ||
      spanMarks !== undefined ||
      loopMarks !== undefined ||
      dependencyMarks;
    const result = jit.options.translate(
      Object.freeze({
        pc,
        code: code as import('../types').BorrowedBytes,
        codeBase: codeRegion?.base ?? 0,
        codeVersion: jit.instance.codeVersion(codeMemory),
        ...(shareMarks === undefined
          ? {}
          : {
              markDirectBodyShareable: (markPc: number, byteLength: number): void => {
                if (!marking) return;
                directStats(jit).directShareCallbacks++;
                shareMarks.push({ pc: markPc, byteLength });
              },
            }),
        ...(spanMarks === undefined
          ? {}
          : {
              markDirectSpan: (markPc: number, instructionCount: number): void => {
                if (!marking) return;
                directStats(jit).directSpanCallbacks++;
                spanMarks.push({ pc: markPc, instructionCount });
              },
            }),
        ...(loopMarks === undefined
          ? {}
          : {
              markDirectLoop: (markPc: number, candidate: JitLoopCandidate): void => {
                if (!marking) return;
                directStats(jit).directLoopCallbacks++;
                loopMarks.push({ pc: markPc, candidate: captureLoopCandidate(candidate) });
              },
            }),
        ...(!dependencyMarks
          ? {}
          : {
              markTranslationDependencies: (ranges: readonly JitTranslationDependency[]): void => {
                if (!marking) return;
                const rejected = directStats(jit).directDependencyMarkRejected;
                if (!Array.isArray(ranges)) {
                  rejected.invalidRange++;
                  return;
                }
                for (const range of ranges) {
                  try {
                    dataObject(range, ['offset', 'length']);
                  } catch {
                    rejected.invalidRange++;
                    continue;
                  }
                  const { offset, length } = range as {
                    readonly offset: unknown;
                    readonly length: unknown;
                  };
                  if (
                    typeof offset !== 'number' ||
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    typeof length !== 'number' ||
                    !Number.isSafeInteger(length) ||
                    length < 0 ||
                    !Number.isSafeInteger(offset + length)
                  ) {
                    rejected.invalidRange++;
                    continue;
                  }
                  if (offset + length > code.length) rejected.outsideView++;
                }
              },
            }),
      }),
      createJitBlockBuilder({ device: jit.model }),
    );
    acceptSync(result);
    marking = false;
    const block = validateBoundBlockIR(result, jit.model);
    if (block.instructions[0]?.pc !== pc) throw new TypeError('Translated first pc does not match');
    const instructions = block.instructions.map((instruction) => {
      const region = codeRegionFor(jit, instruction.pc);
      return {
        pc: instruction.pc,
        nextPc: instruction.nextPc,
        body: instruction.body,
        polling: isPollingInstruction(instruction.body, instruction.pc, jit.options.pc),
        codeRegion: region,
        codeVersion: jit.instance.codeVersion(region?.memory ?? jit.options.code),
      };
    });
    if (spanMarks !== undefined || loopMarks !== undefined)
      applyDirectTimingMarks(jit, instructions, spanMarks ?? [], loopMarks ?? []);
    if (shareMarks !== undefined)
      applyDirectShareMarks(jit, codeRegion, code.length, instructions, shareMarks);
    // Check the old cache before publishing: an overlapping block can replace a routed body
    // instead of only adding PCs. Promotion identity is reconciled from the same snapshot.
    const oldEntries = new Map<number, JitInstruction>();
    for (const entry of instructions) {
      const previous = jit.cache.get(entry.pc);
      if (previous !== undefined) oldEntries.set(entry.pc, previous);
    }
    const replaced = oldEntries.size !== 0;
    // Match the first instruction when a block contains a repeated PC.
    for (let index = instructions.length - 1; index >= 0; index--) {
      const entry = instructions[index]!;
      jit.cache.set(entry.pc, entry);
      jit.cacheMemories.add(entry.codeRegion?.memory ?? jit.options.code);
    }
    if (jit.options.directTier !== undefined) reconcilePromotions(jit, instructions, oldEntries);
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
    marking = false;
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
    if (jit.options.directTier !== undefined) jit.genericInstruction = undefined;
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
    // Compile a generic body only when this instruction actually falls back to it. The
    // compiled body is cached on the translated entry so repeated generic executions pay
    // only the generator call, not another cache lookup/statistic. The compile happens
    // before the PC write or any resource effect, so a failure leaves the original
    // PC/state intact and keeps the translate-phase diagnostic.
    let execute: CompiledBody;
    try {
      execute = instruction.execute ??= body(instruction.body);
    } catch (cause) {
      throw board.wrap(cause, 'JIT_FAILED', 'translate', jit.instance);
    }
    jit.instance.host.write(jit.options.pc, instruction.nextPc);
    if (jit.options.directTier !== undefined) jit.genericInstruction = instruction;
    jit.execution = execute(jit.host);
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
      if (jit.options.directTier !== undefined) {
        const instruction = jit.genericInstruction;
        jit.genericInstruction = undefined;
        if (
          instruction !== undefined &&
          !jit.automaticPolling &&
          board.execution === 'throughput' &&
          board.jits.length === 1
        )
          recordDirectPromotion(jit, instruction.pc, instruction);
      }
      board.boundary('runJit');
      board.queueJit(jit);
      return;
    }
    if (jitSignal(board, jit, step.value)) return;
  }
}
