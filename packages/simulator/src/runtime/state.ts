import type { DeclarationIR, DeviceIR, RegionIR } from '@mica-js/device-model';
import type {
  CompiledBody,
  DirectJitFrame,
  DirectJitProgram,
  ExecutionSignal,
  ReactionFrame,
  ResumableFrame,
  ResumableProgram,
} from '@mica-js/compiler';
import type { Instance } from './instance';
import type { CompiledObservation } from '../observations';
import type { Fifo } from '../queue';
import type { DeviceLibraryEntry, JitDelay, JitOptions } from '../types';

export type Decl<K extends DeclarationIR['kind']> = Extract<DeclarationIR, { kind: K }>;
export type Execution = Generator<ExecutionSignal, unknown, unknown>;
export type Dependencies = ReadonlyMap<ResourceSlot, number>;
export interface ResourceSlot {
  version: number;
  readonly subscribers: Set<Observation>;
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
  readonly entry: { dependencies: Dependencies; value: unknown };
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
  frame: ReactionFrame | undefined;
}
export interface JitInstruction {
  readonly pc: number;
  readonly nextPc: number;
  readonly body: RegionIR;
  readonly execute: CompiledBody;
  readonly polling: boolean;
}
export interface DirectExecution {
  readonly program: DirectJitProgram;
  readonly frame: DirectJitFrame;
  /** PCs the current program compiled; a PC outside it needs the interpreter. */
  readonly pcs: ReadonlySet<number>;
  readonly stateReads: readonly string[];
  readonly stateReadSlots: readonly number[];
  readonly stateWrites: readonly string[];
  readonly stateWriteSlots: readonly number[];
  readonly memoryWrites: readonly string[];
  readonly memoryWriteSlots: readonly number[];
  readonly revision: number;
}
/** Immutable bank layout shared by every direct program built for one JIT. */
export interface DirectJitLayout {
  readonly stateNames: readonly string[];
  readonly memoryNames: readonly string[];
  readonly states: ReadonlyMap<string, number>;
  readonly memories: ReadonlyMap<string, number>;
  readonly memoryBanks: readonly Uint8Array[];
  readonly memoryViews: readonly DataView[];
}
export type DirectJitCache = ReturnType<
  typeof import('@mica-js/compiler').compileDirectJit.createCache
>;
export interface Jit {
  readonly instance: Instance;
  readonly options: JitOptions;
  readonly cache: Map<number, JitInstruction>;
  readonly polling: ReadonlyMap<number, string>;
  /** Validated delay-loop descriptors, keyed by loop-head PC. */
  readonly delays: ReadonlyMap<number, JitDelay>;
  revision: number;
  directRevision: number;
  directObserverRevision: number;
  readonly directStateGuards: Set<string>;
  readonly directMemoryGuards: Set<string>;
  readonly directHookReads: Set<ResourceSlot>;
  readonly directPrograms: Map<string, DirectExecution | undefined>;
  directProgramRevision: number;
  /** Opaque compiler-owned incremental body cache; initialized on the first build. */
  directCache?: DirectJitCache;
  /** Bank names and maps are stable for the lifetime of a JIT. */
  directLayout?: DirectJitLayout;
  direct: DirectExecution | undefined;
  directSkip: number | undefined;
  /** Blocks translated since the last direct program build; bounds the rebuild frequency. */
  directMisses: number;
  pollReads: Dependencies | undefined;
  currentPc: number | undefined;
  automaticPolling: boolean;
  pollingWait: boolean;
  pollingPeriod: number;
  pollingOrigin: number;
  active: boolean;
  stopped: boolean;
  queued: boolean;
  execution: Execution | undefined;
  predicate?: string;
  dependencies?: Dependencies;
}
