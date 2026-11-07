import type { InputPath, OperationIR, SourceInfo } from '@mica-js/device-model';

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
  /** Initial `pc` of a fresh activation; always zero so a frame needs no setup. */
  readonly start: number;
}

export type CompiledComputation = (host: ExecutionHost) => unknown;

/** Static numeric bank layout; the runtime guards ownership/observers before entry. */
export interface DirectJitBinding {
  readonly states: ReadonlyMap<string, number>;
  readonly memories: ReadonlyMap<string, number>;
  readonly pc: { readonly name: string; readonly index: number };
  /** Compile-time write barriers; recompile when membership changes. */
  readonly blockedStates?: ReadonlySet<string>;
  readonly blockedMemories?: ReadonlySet<string>;
}

/** Reusable runtime-owned bank. Flush completed effects even when run throws. */
export interface DirectJitFrame {
  states: unknown[];
  memories: Uint8Array[];
  /** Reusable bit words indexed by bank index >>> 5; clear before each invocation. */
  stateDirty: number[];
  memoryDirty: number[];
  time: number;
  /** Absolute wake time when resume is nonzero. */
  due: number;
  /** Zero means idle; other values are opaque continuations owned by this program. */
  resume: number;
  /** Allocate at least program.localCount slots once, not once per instruction. */
  locals: unknown[];
  /** Complete a pending old instruction, then exit before starting another. */
  stopAfterInstruction?: boolean;
}

export type DirectJitReason = 'deadline' | 'fallback' | 'stopped' | 'invalidated';

export interface DirectJitProgram {
  /** At time === deadline neither an instruction nor its suffix executes. */
  run(frame: DirectJitFrame, deadline: number): DirectJitReason;
  readonly localCount: number;
  readonly readStates: readonly string[];
  readonly writeStates: readonly string[];
  readonly readMemories: readonly string[];
  readonly writeMemories: readonly string[];
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
