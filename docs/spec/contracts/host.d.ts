/** D5 宿主与器件 SDK 合同；声明附件不表示运行时已经实现。 */
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { BlockIR, DeviceIR, InputPath, SourceInfo } from './ir';
import type { JitBlockBuilder } from './builder';
export type { Disposable, Event } from '@mica-js/core/lifecycle';

declare const snapshotTag: unique symbol;
declare const borrowedTag: unique symbol;
declare const libraryTag: unique symbol;

interface ByteReader extends Iterable<number> {
  readonly length: number;
  readonly byteLength: number;
  readonly [index: number]: number | undefined;
  [Symbol.iterator](): IterableIterator<number>;
  slice(start?: number, end?: number): Uint8Array;
}

/** 可跨推进和销毁留存的自有只读快照；slice 返回调用方拥有的可变副本。 */
export interface ReadonlyBytes extends ByteReader {
  readonly [snapshotTag]: true;
}
/** 句柄随所属板或本次翻译失效；内容稳定期与允许读取阶段由 memory 合同规定。 */
export interface BorrowedBytes extends ByteReader {
  readonly [borrowedTag]: true;
}

export interface InputChannel<T> {
  send(value: T): void;
}
export interface InputNotification {
  notify(): void;
}
export interface ChannelMessage<T> {
  readonly time: number;
  readonly value: T;
}
export interface Notification {
  readonly time: number;
}
export interface TopicMessage {
  readonly topic: string;
  readonly payload: unknown;
}
export interface TopicBridge {
  readonly onDidReceive: Event<TopicMessage>;
  publish(topic: string, payload: unknown): void;
}

export interface JitTranslateInput {
  readonly pc: number;
  /** 仅在本次同步 translate 回调内有效。 */
  readonly code: BorrowedBytes;
}
export type JitTranslate = (input: JitTranslateInput, builder: JitBlockBuilder) => BlockIR;
export interface InstructionHook {
  readonly when: string;
  readonly call: string;
}
export interface JitOptions {
  readonly entry: string;
  readonly code: string;
  readonly pc: string;
  readonly beforeInstruction?: InstructionHook;
  readonly translate: JitTranslate;
}
export interface JitHost {
  attachJit(options: JitOptions): Disposable;
  loadBytes(memory: string, bytes: Uint8Array, offset?: number): void;
}

/** 具体字段由生成模块或工厂泛型注解投影；这里不重复声明资源名称。 */
export interface DeviceContext<
  Props extends object = object,
  Inputs extends object = object,
  Memory extends object = object,
> extends JitHost {
  readonly props: Readonly<Props>;
  readonly inputs: Readonly<Inputs>;
  readonly memory: Readonly<Memory>;
  readonly topics: TopicBridge;
  reportError(error: unknown): void;
}
export interface DeviceBatch<Outputs extends object = object> {
  readonly from: number;
  readonly to: number;
  readonly outputs: Readonly<Outputs>;
}
export interface DeviceAdapter<Batch extends DeviceBatch = DeviceBatch> extends Disposable {
  sync(batch: Batch): void;
}
export type DeviceFactory<
  Context extends DeviceContext = DeviceContext,
  Batch extends DeviceBatch = DeviceBatch,
> = (context: Context) => DeviceAdapter<Batch>;

/** 异构登记在库边界擦除器件泛型；工厂使用生成类型或精确的 SDK 泛型注解。 */
export interface DeviceLibraryEntry {
  readonly id: string;
  readonly model: DeviceIR;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 库边界有意擦除异构工厂的类型。
  readonly create: DeviceFactory<any, any>;
}
/** 已校验并捕获模型和登记关系的可复用库；没有运行中资源。 */
export interface DeviceLibrary {
  readonly [libraryTag]: true;
}
export declare function createDeviceLibrary(entries: readonly DeviceLibraryEntry[]): DeviceLibrary;

/** 四个 uint32，不能全零；精确数值合法性在创建前校验。 */
export type RandomState = readonly [number, number, number, number];
export type PropertyInput = number | boolean | string | null | Uint8Array;
export interface InstanceDescription {
  readonly id: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, PropertyInput>>;
  readonly randomState?: RandomState;
}
export interface PinEndpoint {
  readonly instance: string;
  readonly pin: string;
}
export interface NetDescription {
  readonly id: string;
  readonly pins: readonly PinEndpoint[];
  /** 有限对地电压，0 表示地；省略时不建立理想参考。 */
  readonly voltage?: number;
}
export interface BoardDescription {
  readonly instances: readonly InstanceDescription[];
  readonly nets: readonly NetDescription[];
}
export interface BoardOptions {
  /** uint32，省略为 0；实例派生算法见 execution/random。 */
  readonly seed?: number;
}
export type BoardStatus = 'ready' | 'faulted' | 'disposed';
export type RuntimePhase =
  | 'library'
  | 'assembly'
  | 'initialize'
  | 'execute'
  | 'translate'
  | 'sync'
  | 'topic'
  | 'dispose'
  | 'host'
  | 'report';
export type RuntimeDiagnosticCode =
  | 'INVALID_CONFIGURATION'
  | 'MODEL_VALIDATION_FAILED'
  | 'RESOURCE_ALLOCATION_FAILED'
  | 'INVALID_ELECTRICAL_PARAMETER'
  | 'CONFLICTING_REFERENCE'
  | 'ELECTRICAL_SOLVE_FAILED'
  | 'CHANNEL_CONSUMER_CONFLICT'
  | 'INVALID_CALL_STATE'
  | 'OBJECT_DISPOSED'
  | 'BOARD_FAULTED'
  | 'INVALID_BINDING'
  | 'MODEL_EXECUTION_FAILED'
  | 'JIT_FAILED'
  | 'DEVICE_CALLBACK_FAILED'
  | 'ASYNC_HOOK_RESULT'
  | 'CHANNEL_OVERFLOW'
  | 'REPORTED_ERROR'
  | 'CLEANUP_FAILED'
  | 'STALE_REPORT'
  | 'HOST_LISTENER_FAILED';

/** cause 保留原异常引用；只读约束不要求冻结宿主异常对象。 */
export interface RuntimeDiagnostic {
  readonly code: RuntimeDiagnosticCode;
  readonly message: string;
  readonly phase: RuntimePhase;
  readonly time: number | null;
  readonly instanceId?: string;
  readonly resource?: string;
  readonly path?: InputPath;
  readonly source?: SourceInfo;
  readonly cause?: unknown;
  readonly related: readonly RuntimeDiagnostic[];
}
export declare class SimulationError extends Error {
  readonly code: RuntimeDiagnosticCode;
  readonly diagnostic: RuntimeDiagnostic;
  readonly related: readonly RuntimeDiagnostic[];
  constructor(diagnostic: RuntimeDiagnostic);
}

export interface Board extends Disposable {
  readonly time: number;
  readonly status: BoardStatus;
  readonly topics: TopicBridge;
  readonly onDidError: Event<RuntimeDiagnostic>;
  readonly onDidDiagnostic: Event<RuntimeDiagnostic>;
  runUntil(target: number): void;
}
/** 同步捕获配置、建立资源与调用工厂；成功后才返回 ready 板。 */
export declare function createBoard(
  library: DeviceLibrary,
  description: BoardDescription,
  options?: BoardOptions,
): Board;
