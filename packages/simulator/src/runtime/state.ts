import type { DeclarationIR, DeviceIR, RegionIR } from '@mica-js/device-model';
import type {
  CompiledBody,
  DirectJitArtifactCache,
  DirectJitFrame,
  DirectJitSession,
  DirectJitShareCandidate,
  ExecutionSignal,
  ExecutionHost,
  ReactionFrame,
  ResumableFrame,
  ResumableProgram,
  SynchronousProgram,
  SynchronousRunner,
} from '@mica-js/compiler';
import type { Instance } from './instance';
import type { CompiledObservation } from '../observations';
import type { Fifo } from '../queue';
import type {
  DeviceLibraryEntry,
  JitCodeChange,
  JitCodeRegion,
  JitDelay,
  JitLoopCandidate,
  JitOptions,
  JitPolling,
} from '../types';

export type Decl<K extends DeclarationIR['kind']> = Extract<DeclarationIR, { kind: K }>;
export type Execution = Generator<ExecutionSignal, unknown, unknown>;
export type Dependencies = ReadonlyMap<ResourceSlot, number>;
export interface ResourceSlot {
  version: number;
  readonly subscribers: Set<Observation>;
  /**
   * Parked JITs whose recorded dependency set names this slot. Every version bump flags
   * them, so the scheduler rescans only JITs whose inputs actually moved.
   */
  waiters?: Set<Jit> | undefined;
}
/**
 * One validated derived value with the dependency versions it was computed from.
 *
 * `epoch` is the board resource epoch at which those versions were last proven current.
 * A later read that still sees the same epoch serves the value without touching
 * `dependencies`; only a moved epoch falls back to the per-slot version scan. That
 * distinction is worth keeping: mutations cluster inside publication while reads spread
 * between publications, so `camera-mcu` serves 99.93% of its 5638 derived reads per frame
 * from the epoch alone, with 2 scans and 2 recomputations behind it.
 */
export interface DerivedEntry {
  dependencies: Dependencies;
  value: unknown;
  epoch: number;
}
/**
 * All receivers of one compiled observation source. The chain is the queue entry and
 * the static-dependency subscriber, so a publication round evaluates one generated
 * reader instead of one generic source walk per receiver.
 */
export interface ObservationChain {
  readonly plan: CompiledObservation;
  readonly instance: Instance;
  readonly members: Receiver[];
  readonly dependencies: Map<ResourceSlot, number>;
  readonly entry: DerivedEntry;
  order: number;
  previous: unknown;
  bound: boolean;
}
export type Receiver = Process | Reaction;
export type Observation = Receiver | ObservationChain;
export interface Entry {
  readonly id: string;
  readonly model: DeviceIR;
  readonly create: DeviceLibraryEntry['create'];
}
export interface Message {
  readonly time: number;
  readonly value: unknown;
}
export interface Channel {
  readonly declaration: Decl<'channel'>;
  readonly capacity: number;
  readonly maxLength?: number;
  readonly overflow: string;
  readonly incoming: Fifo<Message>;
  readonly pending: Fifo<Message>;
  readonly outgoing: Fifo<Message>;
  receiver?: Process | undefined;
}
export interface Process {
  readonly instance: Instance;
  readonly declaration: Decl<'start'> | Decl<'on'>;
  readonly source?: readonly string[];
  /** Whole-body admission: present only when the body compiled as a resumable block. */
  readonly resumable: ResumableProgram | undefined;
  readSource?: () => unknown;
  previous?: unknown;
  order?: number;
  state: 'idle' | 'queued' | 'running' | 'waiting';
  pending: boolean;
  execution?: Execution | undefined;
  frame?: ResumableFrame | undefined;
  resumeValue?: unknown;
  /** Bound once: a process has at most one pending timed continuation at a time. */
  wake?: () => void;
}
export interface Reaction {
  readonly instance: Instance;
  readonly declaration: Decl<'reaction'>;
  readSource?: () => unknown;
  previous: unknown;
  order?: number;
  execute?: CompiledBody;
  /**
   * Static whole-body admission. `undefined` means not compiled yet; `null` records a
   * compiler decline and selects the generator fallback.
   */
  synchronousProgram?: SynchronousProgram | null;
  /** Bound synchronous runner for this instance; `undefined` until first run. */
  synchronous?: SynchronousRunner | null;
  frame: ReactionFrame | undefined;
}
export interface JitInstruction {
  readonly pc: number;
  readonly nextPc: number;
  readonly body: RegionIR;
  readonly polling: boolean;
  /** 该 instruction 的代码 region；服务 PC 回退主 code 时为 undefined。 */
  readonly codeRegion: JitCodeRegion | undefined;
  /** 按该 entry 的代码 memory 在翻译时读取的版本。 */
  readonly codeVersion: number;
  /** 通过运行时校验的 Direct 指令体共享候选。 */
  readonly share?: DirectJitShareCandidate;
  /** 通过运行时校验的 Direct 合块候选。 */
  readonly span?: {
    readonly pcs: readonly number[];
  };
  /** 通过运行时校验的 Direct 折叠循环候选。 */
  readonly loop?: JitLoopCandidate;
  /** 首次通用执行时编译并缓存的共享体；Direct 路径不读取。 */
  execute?: CompiledBody;
}
/**
 * Per-PC two-tier promotion record. It belongs to one JIT (and therefore one instance):
 * counts only successful generic completions and remembers the exact translation identity.
 */
export interface DirectPromotion {
  count: number;
  state: 'generic' | 'promoted';
  body: RegionIR;
  nextPc: number;
  codeVersion: number;
}
/** Validated polling declaration minus its PC key. */
export type JitPollingBinding = Omit<JitPolling, 'pc'>;
export interface DirectExecution {
  /** Fixed dispatcher plus incrementally installed instruction routes. */
  readonly session: DirectJitSession;
  readonly frame: DirectJitFrame;
  /** Current session routes; rebuilt per access, so use it only for diagnostics. */
  readonly pcs: ReadonlySet<number>;
}
/** Immutable bank layout shared by every direct program built for one JIT. */
export interface DirectJitLayout {
  readonly stateNames: readonly string[];
  readonly stateSlots: readonly ResourceSlot[];
  readonly memoryNames: readonly string[];
  readonly states: ReadonlyMap<string, number>;
  /** Instance-owned bank, mirrored by every interpreted/process/reaction state write. */
  readonly stateValues: unknown[];
  readonly memories: ReadonlyMap<string, number>;
  readonly memoryBanks: readonly Uint8Array[];
  readonly memoryViews: readonly DataView[];
  readonly pinNames: readonly string[];
  readonly pins: ReadonlyMap<string, number>;
  readonly pinObjects: readonly import('../electrical').ElectricalPin[];
  readonly pinElectricalSlots: Int32Array;
}
export type DirectJitCache = ReturnType<
  typeof import('@mica-js/compiler').compileDirectJit.createCache
>;
export interface JitMetadataRegion {
  readonly region: JitCodeRegion;
  /** -1 until the first successful provider call for this region. */
  appliedVersion: number;
  /** Force a provider revalidation even when the write range is outside this region. */
  dirty: boolean;
  readonly pending: JitCodeChange[];
  readonly polling: Map<number, JitPollingBinding>;
  readonly delays: Map<number, JitDelay>;
}
export interface JitMetadataState {
  readonly regions: Map<JitCodeRegion, JitMetadataRegion>;
  /** Aggregated declarations from all refreshed regions. Rebuilt atomically. */
  readonly polling: Map<number, JitPollingBinding>;
  readonly delays: Map<number, JitDelay>;
}
export interface Jit {
  readonly instance: Instance;
  readonly options: JitOptions;
  readonly model: DeviceIR;
  readonly host: ExecutionHost;
  readonly functions?: ReadonlyMap<string, Decl<'function'>>;
  /** 规范化后的不可变 region 列表；第一项永远是主 `code` 的隐式 0 基址 region。 */
  readonly codeRegions: readonly JitCodeRegion[];
  readonly cache: Map<number, JitInstruction>;
  /** 当前 cache 中拥有 instruction 的代码 memory；用于跳过无关数据写。 */
  readonly cacheMemories: Set<string>;
  /**
   * 两级 Direct 晋升记录，按逻辑 PC 保存；未设置 `directTier` 时始终为空。
   * 计数和身份只在当前实例内有效，不进入共享工件缓存。
   */
  readonly promotions: Map<number, DirectPromotion>;
  readonly polling: ReadonlyMap<number, JitPollingBinding>;
  /** 仅 codeMetadata provider 模式存在；静态路径为 undefined。 */
  readonly metadata: JitMetadataState | undefined;
  /** Validated delay-loop descriptors, keyed by loop-head PC. */
  readonly delays: ReadonlyMap<number, JitDelay>;
  revision: number;
  directObserverRevision: number;
  readonly directStateGuards: Set<string>;
  readonly directMemoryGuards: Set<string>;
  readonly directHookReads: Set<ResourceSlot>;
  /** Memories that currently supply at least one direct-admitted instruction. */
  readonly directMemories: Set<string>;
  /** 本注册选择的 Direct 编译器工件缓存；默认独立，显式共享时指向进程级缓存。 */
  readonly artifactCache: DirectJitArtifactCache;
  /** Opaque compiler-owned incremental body cache; initialized on the first build. */
  directCache?: DirectJitCache;
  /** Bank names and maps are stable for the lifetime of a JIT. */
  directLayout?: DirectJitLayout;
  direct: DirectExecution | undefined;
  directSkip: number | undefined;
  /**
   * The active session must not accept new routes or start another instruction. A
   * suspended old suffix still owns its frame until it completes once.
   */
  directStale: boolean;
  /** The compiler body cache belongs to replaced code bytes and must be dropped first. */
  directCacheInvalid: boolean;
  pollReads: Dependencies | undefined;
  currentPc: number | undefined;
  automaticPolling: boolean;
  pollingWait: boolean;
  pollingPeriod: number;
  pollingOrigin: number;
  /** Invalidates a previously scheduled polling time event after any other wake. */
  pollingToken: number;
  /** A dependency slot was invalidated after this JIT parked; its predicate may now hold. */
  dependencyDirty: boolean;
  /** The dependency set already registered in `ResourceSlot.waiters`. */
  waiterSlots: Dependencies | undefined;
  active: boolean;
  stopped: boolean;
  queued: boolean;
  execution: Execution | undefined;
  /** 拥有 `execution` 的通用指令；`beforeInstruction` 钩子执行时为 undefined。 */
  genericInstruction: JitInstruction | undefined;
  predicate?: string;
  dependencies?: Dependencies;
}
