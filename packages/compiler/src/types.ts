import type {
  DeclarationIR,
  InputPath,
  OperationIR,
  RegionIR,
  SourceInfo,
} from '@mica-js/device-model';
import type { ProcessBatchPlan } from './batch.js';

export type ExecutionSignal =
  | { readonly kind: 'ticks' | 'elapse'; readonly duration: number }
  | { readonly kind: 'receive'; readonly channel: string }
  | { readonly kind: 'waitUntil'; readonly predicate: string }
  | { readonly kind: 'redirect'; readonly pc: number; readonly delay: number }
  | { readonly kind: 'stop' };

export interface ReactionFrame {
  readonly previous: unknown;
  readonly current: unknown;
  readonly captures: readonly unknown[];
}

/**
 * Per-instance handle for one fixed resource name. A resumable process body binds its
 * resources once per frame and then calls these methods instead of resolving a name on
 * every operation. Every method keeps the exact behaviour of the corresponding
 * `ExecutionHost` operation, including validation, snapshotting and invalidation.
 */
export interface ResourceHandle {
  /** State read; the value is the live stored value. */
  read?: () => unknown;
  /** State write: validates, snapshots and invalidates like `ExecutionHost.write`. */
  write?: (value: unknown) => void;
  /** Current immutable sample of the pin, read fresh on every call. */
  sample?: () => unknown;
  intent?: (value: unknown) => void;
  resistor?: (resistance: unknown) => unknown;
  load8?: (offset: unknown) => number;
  load16le?: (offset: unknown) => number;
  load16be?: (offset: unknown) => number;
  load32le?: (offset: unknown) => number;
  load32be?: (offset: unknown) => number;
  store8?: (offset: unknown, value: unknown) => void;
  store16le?: (offset: unknown, value: unknown) => void;
  store16be?: (offset: unknown, value: unknown) => void;
  store32le?: (offset: unknown, value: unknown) => void;
  store32be?: (offset: unknown, value: unknown) => void;
  length?: () => number;
  copy?: (offset: unknown, length: unknown) => unknown;
}

export interface ExecutionHost {
  read(resource: 'property' | 'const' | 'state' | 'derived', name: string): unknown;
  write(name: string, value: unknown): void;
  sample(pin: unknown): unknown;
  intent(pin: unknown, value: unknown): void;
  resistor(pin: unknown, resistance: unknown): unknown;
  load(kind: string, memory: unknown, offset: unknown): number;
  store(kind: string, memory: unknown, offset: unknown, value: unknown): void;
  copyBytes(memory: unknown, offset: unknown, length: unknown): unknown;
  memoryLength(memory: unknown): number;
  send(name: string, value: unknown): void;
  notify(name: string): void;
  now(): number;
  random(): number;
  call(name: string, args: readonly unknown[]): Generator<ExecutionSignal, unknown, unknown>;
  assert(condition: unknown, message: unknown): void;
  /**
   * Binds fixed resource names to per-instance handles. A resumable process body calls
   * this once per frame, so all instances and processes stay isolated. Hosts that never
   * opt into `CompileOptions.bindResources` do not need it.
   */
  bind?(specs: readonly (readonly [string, string])[]): readonly ResourceHandle[];
}

export type CompiledBody = (
  host: ExecutionHost,
  args?: readonly unknown[],
  reaction?: ReactionFrame,
) => Generator<ExecutionSignal, unknown, unknown>;

/** Suspension kinds a resumable body writes to its frame before returning. */
export const RESUMABLE_TICKS = 1;
export const RESUMABLE_RECEIVE = 2;

/**
 * Reusable per-process frame for a resumable body. `pc` is opaque to the runtime:
 * zero restarts the body, any other value continues the suspension the body recorded.
 */
export interface ResumableFrame {
  pc: number;
  /** Body-owned local frame; sized by `ResumableProgram.slotCount` and reused. */
  readonly slots: unknown[];
  /** `RESUMABLE_TICKS` or `RESUMABLE_RECEIVE` when `run` returned true. */
  kind: number;
  duration: number;
  channel: string;
  /** Value delivered to the pending receive continuation before the next `run`. */
  value: unknown;
  /** Per-instance resource handles, bound on the first run of this frame. */
  resources?: readonly ResourceHandle[];
}

/** Returns true when the body suspended, false when it completed. */
export type ResumableBody = (
  host: ExecutionHost,
  args: readonly unknown[] | undefined,
  reaction: ReactionFrame | undefined,
  frame: ResumableFrame,
) => boolean;

export interface ResumableProgram {
  readonly run: ResumableBody;
  readonly slotCount: number;
  /** Generated machine blocks; a read-only measure of how much of the body was fused. */
  readonly blocks: number;
  /** Initial `pc` of a fresh activation; always zero so a frame needs no setup. */
  readonly start: number;
  /**
   * Opt-in proof per top-level `while`, indexed by source order. `undefined` entries keep
   * the ordinary path; the property is absent unless `batchLoops` was requested.
   */
  readonly batchLoops?: readonly (ProcessBatchPlan | undefined)[];
}

/** `CompileOptions` plus the resumable-only process-batch proof request. */
export interface ResumableCompileOptions extends CompileOptions {
  /** Prove eligible top-level loops and expose `ResumableProgram.batchLoops`. */
  readonly batchLoops?: boolean;
}

export type CompiledComputation = (host: ExecutionHost) => unknown;

declare const directJitCacheOpaque: unique symbol;

/**
 * Opaque, reusable compilation state for the direct backend.
 *
 * A cache owns compiled instruction bodies and the constant indices they reference. Callers
 * must obtain one from `compileDirectJit.createCache()` and may discard it at any time; every
 * program produced by the compiler remains self-contained.
 */
export interface DirectJitCache {
  readonly [directJitCacheOpaque]: true;
}

/** Deterministic cache counters; useful for diagnostics and targeted regression tests. */
export interface DirectJitCacheStats {
  /** Instruction bodies emitted after a cache miss. */
  readonly compiledBlocks: number;
  /** Instruction bodies reused without running the emitter. */
  readonly reusedBlocks: number;
  /** Previously cached bodies replaced because their PC/body/binding fingerprint changed. */
  readonly invalidatedBlocks: number;
  /** Resident shard factories emitted for split programs. */
  readonly compiledShards: number;
  /** Resident shards reused unchanged across program assemblies. */
  readonly reusedShards: number;
  /** Cached entries, including bodies the direct emitter declined. */
  readonly entries: number;
  /** Explicit cache clears requested by the runtime or a caller. */
  readonly clears: number;
}

declare const directJitArtifactOpaque: unique symbol;

/**
 * Opaque, bounded compiler artifact cache shared by sessions and boards.
 *
 * The cache owns immutable instruction templates, their compatible append-only constant pool,
 * stable resistor slots and resident shard source factories. It never owns a frame, route
 * table, continuation id, capture slot or other instance state. Obtain one from
 * `compileDirectJit.createArtifactCache()`; sessions keep their compiled functions alive
 * after eviction.
 */
export interface DirectJitArtifactCache {
  readonly [directJitArtifactOpaque]: true;
}

/** Deterministic cross-session artifact counters; no value depends on wall-clock time. */
export interface DirectJitArtifactCacheStats {
  /** Instruction templates emitted after a miss. */
  readonly compiledInstructions: number;
  /** Instruction templates reused from the artifact cache. */
  readonly reusedInstructions: number;
  /** Resident shard sources reused before regeneration. */
  readonly reusedShardSources: number;
  /** Unbound shard factories created with new Function. */
  readonly createdFactories: number;
  /** Unbound shard factories reused. */
  readonly reusedFactories: number;
  /** Current entries in the instruction LRU. */
  readonly instructionEntries: number;
  /** Current entries in the shard factory LRU. */
  readonly shardEntries: number;
  /** Current cumulative source characters retained by the shard cache. */
  readonly sourceUnits: number;
  /** LRU evictions from either cache. */
  readonly evictions: number;
  readonly clears: number;
}

export interface DirectJitDelay {
  readonly counter: number;
  readonly cycles: number;
  readonly pending?: {
    readonly state: number;
    readonly period: number;
    readonly active: number;
  };
}

/** Static numeric bank layout plus runtime entry and write-publication guards. */
export interface DirectJitBinding {
  readonly states: ReadonlyMap<string, number>;
  readonly memories: ReadonlyMap<string, number>;
  /** Optional pin name → slot index table for direct sample reads and intent writes. */
  readonly pins?: ReadonlyMap<string, number>;
  readonly pc: { readonly name: string; readonly index: number };
  /** Validated synchronous functions eligible for same-frame direct calls. */
  readonly functions?: ReadonlyMap<string, Extract<DeclarationIR, { kind: 'function' }>>;
  /** Entry-blocked state slots: `beforeInstruction` hook reads. */
  readonly entryBlockedStates?: ReadonlySet<string>;
  /** Entry-blocked memory slots: self-modifying code and `beforeInstruction` hook reads. */
  readonly entryBlockedMemories?: ReadonlySet<string>;
  /** Observed state slots: writes publish dynamically at the next instruction boundary. */
  readonly blockedStates?: ReadonlySet<string>;
  /** Observed memory slots: stores publish dynamically at the next instruction boundary. */
  readonly blockedMemories?: ReadonlySet<string>;
  /** Set when the runtime supplies `DirectJitFrame.host` for side-effecting operations. */
  readonly host?: boolean;
  /** Emit a small set of shard functions instead of one monolithic function. */
  readonly split?: boolean;
  /** Instructions per split shard; defaults to 48. */
  readonly shardSize?: number;
  /** Summed slot count above which `split` emits shards; defaults to 2048. */
  readonly shardSlotLimit?: number;
  /**
   * PC → `{ counter slot, ps per round, optional service accumulator }` of a declared
   * busy-wait loop head. The emitted body collapses every round the deadline allows before
   * executing the real iteration.
   *
   * A device whose paced peripherals are driven by an accumulator (SysTick, UART bit clocks)
   * supplies `pending`: the fold then stops at the next service boundary and adds the folded
   * time to the accumulator, so skipping rounds cannot starve those peripherals.
   */
  readonly delayLoops?: ReadonlyMap<number, DirectJitDelay>;
  /** Numeric slots and optional pure guard for device timing admission. */
  readonly directTiming?: DirectJitTiming;
  /** Physical length of each memory bank, used to prove static address ranges. */
  readonly memoryLengths?: ReadonlyMap<string, number>;
  /** Memories that contain executable code; prefix stores there are rejected. */
  readonly codeMemories?: ReadonlySet<string>;
}

/** Compile-time address of one counter byte below a direct loop candidate. */
export type DirectJitMemoryAddress =
  | { readonly kind: 'constant'; readonly offset: number }
  | {
      readonly kind: 'maskedByte';
      readonly memory: string;
      readonly offset: number;
      readonly mask: number;
      readonly bits: number;
    };

/** A self-jumping direct instruction the compiler may fold into many rounds. */
export type DirectJitLoopCandidate =
  | { readonly kind: 'spin' }
  | {
      readonly kind: 'decrement8';
      readonly memory: string;
      readonly address: DirectJitMemoryAddress;
    };

/** Resolved contiguous instruction PCs of a marked span; first entry is the marked PC. */
export interface DirectJitSpanCandidate {
  readonly pcs: readonly number[];
}

/** Device timing admission for marked spans and loops. */
export interface DirectJitTiming {
  /** Number-state slot holding the device service elapsed time (ps). */
  readonly elapsed: number;
  /** Number-state slot holding the device service deadline (ps), 0 = no service. */
  readonly deadline: number;
  /** Name of a validated pure zero-argument bool function; true forces the normal path. */
  readonly blocked?: string;
}

/**
 * Runtime host calls available to a direct program. The simulator supplies its instance
 * host; methods retain the generic execution contract, including validation and snapshotting.
 */
export interface DirectJitHost {
  send(name: string, value: unknown): void;
  sample(pin: unknown): unknown;
  intent(pin: unknown, value: unknown): void;
  resistor(pin: unknown, resistance: unknown): unknown;
  notify(name: string): void;
  now(): number;
  random(): number;
  assert(condition: unknown, message: unknown): void;
}

/** Reusable runtime-owned bank. Flush completed effects even when run throws. */
export interface DirectJitFrame {
  states: unknown[];
  memories: Uint8Array[];
  /** Optional per-bank wrappers prepared once by the runtime; absent in compiler-only frames. */
  readonly memoryViews?: readonly DataView[];
  /** Optional prebound pin objects indexed by `DirectJitBinding.pins`. */
  readonly pins?: readonly { readonly sample: unknown }[];
  /** Optional per-frame cache for constant resistor intents. */
  resistors?: unknown[];
  /** Optional prebound pin-intent writer indexed by `DirectJitBinding.pins`. */
  writePinIntent?: (pinIndex: number, value: unknown) => void;
  /** Reusable bit words indexed by bank index >>> 5; clear before each invocation. */
  stateDirty: number[] | Int32Array;
  memoryDirty: number[] | Int32Array;
  time: number;
  /** Absolute wake time when resume is nonzero. */
  due: number;
  /** Zero means idle; other values are opaque continuations owned by this program. */
  resume: number;
  /** Allocate at least program.localCount slots once, not once per instruction. */
  locals: unknown[];
  /** Complete a pending old instruction, then exit before starting another. */
  stopAfterInstruction?: boolean;
  /** Publish host effects at the next nonzero elapse or instruction end before continuing. */
  publishPending?: boolean;
  /**
   * At a positive elapse strictly before the deadline, publish the suspended prefix
   * at `time`. Return true only if this instruction's suffix may run at `due`
   * without returning to the scheduler. On false the continuation is saved normally.
   */
  publishCheckpoint?: () => boolean;
  /**
   * Finish an admitted inline suffix at `time` and settle its boundary. Return true
   * only if the next instruction may run in this same program with the same deadline.
   * An empty suffix cannot have produced dirty bank slots or host effects.
   */
  finishCheckpoint?: (deadline: number, emptySuffix: boolean) => boolean;
  /** Present when the program was compiled with `DirectJitBinding.host`. */
  readonly host?: DirectJitHost;
  /** Optional mutable counters for span/loop execution; the runtime aggregates them. */
  readonly directMetrics?: { spanRuns: number; loopRounds: number };
}

export type DirectJitReason = 'deadline' | 'fallback' | 'stopped' | 'invalidated';

export interface DirectJitProgram {
  /** At time === deadline neither an instruction nor its suffix executes. */
  run(frame: DirectJitFrame, deadline: number): DirectJitReason;
  /** Generated step/resume function groups; one for the monolithic form. */
  readonly shards: number;
  /** PCs this program compiled, and therefore can execute without the interpreter. */
  readonly pcs: readonly number[];
  readonly localCount: number;
  readonly readStates: readonly string[];
  readonly writeStates: readonly string[];
  readonly readMemories: readonly string[];
  readonly writeMemories: readonly string[];
}

/**
 * Development-only code shape: how many host statements one IR operation costs. The full
 * program exposes the latest build's value, and an incremental session exposes the union of
 * its currently valid instruction bodies.
 */
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
 * Physical identity of one translated instruction body. Two logical PCs may name the same
 * bytes of one storage generation; they are only considered for sharing when every field
 * matches.
 */
export interface DirectJitShareCandidate {
  /** Storage identity, for example the memory name. */
  readonly storage: string;
  /** Code version used for the translation. */
  readonly codeVersion: number;
  /** Physical offset of this entry in the borrowed view. */
  readonly offset: number;
  /** Actual bytes fetched consecutively from this entry. */
  readonly byteLength: number;
}

/**
 * One translated instruction submitted to an incremental direct JIT session.
 *
 * The entry is committed atomically with the rest of its `add` batch. The body stays opaque
 * so a later revision can attach sharing metadata without changing this contract.
 */
export interface DirectJitInstruction {
  readonly pc: number;
  readonly nextPc: number;
  readonly body: RegionIR;
  /** Explicit opt-in to function-body sharing; unmarked entries always stay independent. */
  readonly share?: DirectJitShareCandidate;
  /** Marked contiguous instructions fused when every prefix member is provably pure. */
  readonly span?: DirectJitSpanCandidate;
  /** Marked self-jump folded into as many complete rounds as the horizon allows. */
  readonly loop?: DirectJitLoopCandidate;
}

/**
 * A direct execution result. `untranslated` asks the caller to translate the current PC and
 * call `add`; `pending` is reserved for a future asynchronous translation path and is not
 * returned by the synchronous session today.
 */
export type DirectJitRunResult = DirectJitReason | 'untranslated' | 'pending';

/**
 * Why a marked entry did not join an equivalent shared body. Counters are cumulative and
 * only advance when an entry's classification changes, so an unchanged commit adds nothing.
 */
export interface DirectJitShareRejectedStats {
  /** No marker, or a previously marked PC was replaced by an unmarked entry. */
  readonly missing: number;
  /** The marker was present but not a valid storage/version/offset/byteLength tuple. */
  readonly invalid: number;
  /** The entry is the only candidate for its physical identity or equivalence partition. */
  readonly single: number;
  /** A same-key candidate has the same delay but a different validated IR. */
  readonly ir: number;
  /** A same-key candidate has different IR and delay, or a different delay fingerprint. */
  readonly delay: number;
  /** Loop-publishing entries never share in this revision. */
  readonly isolated: number;
  /** The body could not be emitted in this session's compilation context. */
  readonly context: number;
}

/** Deterministic per-session counters; no value depends on wall-clock time. */
export interface DirectJitSessionStats {
  /** Completed `add` calls, including batches that only reused cached instructions. */
  readonly batches: number;
  /** Route entries written after an instruction body or shard function changed. */
  readonly routeInstalls: number;
  /** Route entries deleted because their PC was removed or rejected. */
  readonly routeRemovals: number;
  /** Shard functions emitted by this session. */
  readonly compiledShards: number;
  /** Existing shard functions retained across a session commit. */
  readonly reusedShards: number;
  /** Instruction bodies emitted by this session. */
  readonly compiledBlocks: number;
  /** Instruction bodies reused from the cache by this session. */
  readonly reusedBlocks: number;
  /** Instruction templates reused from the artifact cache by this session. */
  readonly artifactInstructionHits: number;
  /** Instruction templates this session had to emit after an artifact lookup miss. */
  readonly artifactInstructionMisses: number;
  /** Cached instruction records replaced or deleted by this session. */
  readonly invalidatedBlocks: number;
  /** Currently dispatchable PCs. */
  readonly routes: number;
  /** Currently resident shard functions. */
  readonly shards: number;
  /** Cumulative generated source characters of emitted instruction bodies. */
  readonly bodyBytes: number;
  /** Cumulative generated source characters of emitted shard functions. */
  readonly shardBytes: number;
  /** Generated source characters of the one fixed dispatcher. */
  readonly dispatcherBytes: number;
  /** Cumulative generated source characters of separately compiled synchronous helpers. */
  readonly helperBytes: number;
  /** Valid share candidates currently owned by the session. */
  readonly shareCandidates: number;
  /** Equivalence groups currently backed by a shared body, including retained single routes. */
  readonly shareGroups: number;
  /** Current routes that point at a shared body. */
  readonly sharedRoutes: number;
  /** Entry attachments that reused an already emitted shared body instead of emitting one. */
  readonly shareReusedBodies: number;
  /** Shared-body route installs, including migrations from independent shard routes. */
  readonly shareReusedRoutes: number;
  /** Cumulative rejection reasons for marked entries. */
  readonly shareRejected: DirectJitShareRejectedStats;
  /** Shared step/resume factories emitted by this session. */
  readonly sharedBodies: number;
  /** Cumulative generated source characters of emitted shared bodies. */
  readonly sharedBytes: number;
  /** Marked spans that became a fused step route. */
  readonly spansInstalled: number;
  /** Marked spans rejected by structural or timing proof. */
  readonly spansRejected: number;
  /** Fused span routes that actually executed the fused path. */
  readonly spanRuns: number;
  /** Marked loops that became a folding route. */
  readonly loopsInstalled: number;
  /** Marked loops rejected by structural or timing proof. */
  readonly loopsRejected: number;
  /** Total rounds folded by installed loop routes. */
  readonly loopRounds: number;
}

/**
 * Incremental resident direct compiler for one JIT registration.
 *
 * The binding is fixed for the lifetime of the session. `add` commits translation batches,
 * `remove` drops entries, and `updateDelays` reconciles busy-wait descriptions. The dispatch
 * function is emitted once; later commits only install routes to new or rebuilt shards.
 */
export interface DirectJitSession {
  run(frame: DirectJitFrame, deadline: number): DirectJitRunResult;
  add(instructions: readonly DirectJitInstruction[]): void;
  remove(pcs: readonly number[]): void;
  updateDelays(delays?: ReadonlyMap<number, DirectJitDelay>): void;
  clear(): void;
  /** Whether a compiled route currently dispatches the PC. Rejected bodies report false. */
  has(pc: number): boolean;
  /**
   * Locals required by every instruction ever compiled by this session. Only grows, so a
   * runtime can expand `frame.locals` in place when a later batch needs more slots.
   */
  readonly localCount: number;
  readonly shardCount: number;
  readonly routeCount: number;
  /** Sorted PCs the session can dispatch; bodies the direct emitter declined are excluded. */
  readonly pcs: readonly number[];
  /**
   * Development-only code shape over every currently valid instruction body. Updated by
   * session commits (`add`/`remove`/`updateDelays`/`clear`), never during `run`.
   */
  readonly emitStats: DirectJitEmitStats;
  stats(): DirectJitSessionStats;
  /** Detach from the cache. Other programs/sessions keep their own compiled snapshots. */
  dispose(): void;
}

/** Generated line and column are one-based, relative to Artifact.source. */
export interface GeneratedPosition {
  readonly path: InputPath;
  readonly kind: OperationIR['kind'];
  readonly line: number;
  readonly column: number;
  readonly source?: SourceInfo;
}

export interface ResumePoint extends GeneratedPosition {
  readonly id: number;
  /** Calls may suspend or terminate through any transitive callee. */
  readonly delegated: boolean;
}

/** Effects are conservative and syntactic; calls require runtime/model call-graph analysis. */
export interface EffectMetadata {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly calls: readonly string[];
  readonly operations: readonly OperationIR['kind'][];
  readonly maySuspend: boolean;
  readonly mayRedirect: boolean;
  readonly mayStop: boolean;
  readonly timeDependent: boolean;
  readonly random: boolean;
}

export interface Artifact<T = CompiledBody> {
  readonly execute: T;
  readonly source: string;
  readonly constants: readonly unknown[];
  readonly positions: readonly GeneratedPosition[];
  readonly resume: readonly ResumePoint[];
  readonly effects: EffectMetadata;
  readonly mir: InternalGraph;
  readonly dependencies: ArtifactDependencies;
  readonly sourceMap: SourceMap;
  readonly frameLayout: FrameLayout;
  readonly resumeMap: ResumeMap;
  readonly exitMap: readonly ExitPoint[];
  readonly optimizations: OptimizationMetadata;
}

export interface CompileOptions {
  readonly optimize?: boolean;
  /** Optional identity supplied by the binding runtime; it is never guessed from a body. */
  readonly binding?: ArtifactBinding;
  /**
   * Emit per-instance resource handles for fixed pin/state/memory names. The runtime
   * then supports `ExecutionHost.bind`, which is called once per resumable frame.
   */
  readonly bindResources?: boolean;
}

export interface ArtifactBinding {
  readonly instance?: string;
  readonly entry?: string;
  readonly generation?: number;
  readonly codeVersion?: string | number;
  readonly instruction?: { readonly pc: number; readonly nextPc: number };
}

export interface ArtifactDependencies {
  readonly binding: ArtifactBinding | null;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly calls: readonly string[];
  readonly resources: readonly string[];
  readonly unresolvedCalls: boolean;
}

export interface OperationEffects extends EffectMetadata {
  readonly mayThrow: boolean;
}

export type EdgeKind =
  | 'next'
  | 'true'
  | 'false'
  | 'arm'
  | 'default'
  | 'backedge'
  | 'break'
  | 'continue'
  | 'yield'
  | 'return'
  | 'suspend'
  | 'resume'
  | 'redirect'
  | 'stop'
  | 'throw';

export interface ControlEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: EdgeKind;
  readonly arm?: number;
  readonly value?: number;
}

/** One operation per block is intentional; joins/resume/exit blocks are explicit. */
export interface BasicBlock {
  readonly id: number;
  readonly region: number;
  readonly role:
    'operation' | 'entry' | 'exit' | 'join' | 'resume' | 'return' | 'throw' | 'stop' | 'redirect';
  readonly position: number | null;
  readonly predecessors: readonly number[];
  readonly successors: readonly number[];
  readonly uses: readonly string[];
  readonly definitions: readonly string[];
  readonly liveIn: readonly string[];
  readonly liveOut: readonly string[];
  readonly baselineLiveIn: readonly string[];
  readonly baselineLiveOut: readonly string[];
}

export interface InternalRegion {
  readonly id: number;
  readonly parent: number | null;
  readonly path: InputPath;
  readonly entry: number;
  readonly exit: number;
}

export interface ValueDefinition {
  readonly result: number;
  readonly type: import('@mica-js/device-model').ValueTypeIR;
  readonly position: number;
  readonly region: number;
  readonly block: number;
  readonly form: 'operation' | 'phi';
  readonly inputs: readonly number[];
  readonly users: readonly number[];
  readonly eliminated: boolean;
  readonly folded: boolean;
}

export type InternalAttribute =
  | string
  | number
  | boolean
  | null
  | readonly InternalAttribute[]
  | { readonly [key: string]: InternalAttribute };

export interface InternalOperation {
  readonly position: number;
  readonly block: number;
  readonly region: number;
  readonly kind: OperationIR['kind'];
  readonly path: InputPath;
  readonly source?: SourceInfo;
  readonly inputs: readonly number[];
  readonly attributes: Readonly<Record<string, InternalAttribute>>;
  readonly regions: readonly { readonly role: string; readonly region: number }[];
  readonly effects: OperationEffects;
  readonly eliminated: boolean;
  readonly folded: boolean;
}

/** SSA result definitions plus explicit mutable local slots; locals are not SSA-promoted. */
export interface InternalGraph {
  readonly entry: number;
  readonly normalExit: number;
  readonly regions: readonly InternalRegion[];
  readonly blocks: readonly BasicBlock[];
  readonly edges: readonly ControlEdge[];
  readonly operations: readonly InternalOperation[];
  readonly values: readonly ValueDefinition[];
}

export interface GeneratedRange {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
}

export interface SourceMapEntry {
  readonly position: number;
  readonly block: number;
  readonly path: InputPath;
  readonly kind: OperationIR['kind'];
  readonly source?: SourceInfo;
  readonly generated: GeneratedRange | null;
  readonly eliminated: boolean;
  readonly folded: boolean;
}

export interface SourceMap {
  readonly entries: readonly SourceMapEntry[];
}

export interface FrameSlot {
  readonly id: number;
  readonly key: string;
  readonly kind: 'value' | 'local' | 'argument' | 'reaction' | 'temporary';
  readonly name: string;
  readonly region: number;
  readonly definition: number | null;
  readonly materialized: boolean;
  readonly type?: import('@mica-js/device-model').ParameterTypeIR;
}

/** Describes actual native-generator bindings, not an externally writable stack frame. */
export interface FrameLayout {
  readonly storage: 'native-generator';
  readonly serializable: false;
  readonly slots: readonly FrameSlot[];
  readonly materializations: readonly ConstantMaterialization[];
}

export interface ConstantMaterialization {
  readonly slot: number;
  readonly kind: 'constant';
  readonly value: number | boolean | string | null;
}

export interface BaselinePosition {
  readonly position: number;
  readonly block: number;
  readonly phase: 'before' | 'after' | 'delegate';
}

export interface ResumeLocation {
  readonly id: number;
  readonly kind: OperationIR['kind'];
  readonly suspended: BaselinePosition;
  readonly baseline: BaselinePosition;
  readonly generated: GeneratedRange;
  readonly continuation: { readonly line: number; readonly column: number };
  readonly liveSlots: readonly number[];
  readonly delegated: boolean;
  readonly terminal: boolean;
}

export interface ResumeMap {
  readonly entries: readonly ResumeLocation[];
}

export type ExitReason = 'return' | 'suspend' | 'redirect' | 'stop' | 'throw' | 'deopt';

export interface ExitPoint {
  readonly baseline: BaselinePosition;
  readonly reason: ExitReason;
  readonly generated: GeneratedRange;
  readonly requiredSlots: readonly number[];
  readonly captureSlots: readonly number[];
}

/** Data contract for a future consumer; current generators do not expose their slots. */
export interface ExitState {
  readonly reason: ExitReason;
  readonly baseline: BaselinePosition;
  readonly values: readonly { readonly slot: number; readonly value: unknown }[];
  readonly signal?: ExecutionSignal;
  readonly value?: unknown;
  readonly cause?: unknown;
  /** A retained native continuation is required for resuming this backend's stack. */
  readonly continuation?: Generator<ExecutionSignal, unknown, unknown>;
}

export interface OptimizationMetadata {
  readonly enabled: boolean;
  readonly foldedPositions: readonly number[];
  readonly eliminatedPositions: readonly number[];
}
