/** D5 宿主与器件 SDK 合同；声明附件不表示运行时已经实现。 */
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type {
  BlockIR,
  DeclarationIR,
  DeviceIR,
  InputPath,
  SourceInfo,
  JitBlockBuilder,
} from '@mica-js/device-model';
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

/** 一段可执行代码区域；`base` 是逻辑 PC 基址，区域从对应 memory 的偏移 0 开始。 */
export interface JitCodeRegion {
  readonly memory: string;
  readonly base: number;
  readonly size: number;
}
/** Direct 时间准入声明；`service` 引用本实例 number 状态，`blocked` 引用安静的 pure fn。 */
export interface JitDirectTiming {
  /**
   * 定时服务状态名：`elapsed` 是自同一上次结算点起的已累计量，`deadline` 是该时点的期限，
   * 单位均为 ps；`deadline` 为 0 表示当前无定时服务。两项须在运行时为非负安全整数，
   * 否则候选使用普通指令路径。
   */
  readonly service?: {
    /** 自同一上次结算点起的已累计时间，单位 ps。 */
    readonly elapsed: string;
    /** 自同一上次结算点起的期限，单位 ps；0 表示无定时服务。 */
    readonly deadline: string;
  };
  /** 同步、确定、不抛错且只读的无参 bool `pure fn`；为真时使用普通指令路径。 */
  readonly blocked?: string;
}
/** 循环计数地址：常量偏移，或由选择字节按 `(selectorByte & mask) | bits` 合成的字节偏移。 */
export type JitLoopAddress =
  | { readonly kind: 'constant'; readonly offset: number }
  | {
      readonly kind: 'maskedByte';
      readonly memory: string;
      readonly offset: number;
      /** 选择字节的位掩码。 */
      readonly mask: number;
      /** 合成地址中置位的位。 */
      readonly bits: number;
    };
/** 忙等循环候选：无计数器的自跳，或每轮递减一字节并按新值非零自跳。 */
export type JitLoopCandidate =
  | { readonly kind: 'spin' }
  | {
      readonly kind: 'decrement8';
      readonly memory: string;
      readonly address: JitLoopAddress;
    };
/** 同步翻译期提供的 Direct 时间候选标记；仅本次 `translate` 回调内有效。 */
export interface JitDirectTimingInput {
  /**
   * 标记返回块中从 `pc` 起、共 `instructionCount`（2–8）条连续指令组成的合块：纯定长
   * 前缀后接一条普通 GPIO/SFR 终结写。非法、重复或无法证明的标记只取消该优化。
   */
  readonly markDirectSpan?: (pc: number, instructionCount: number) => void;
  /** 标记以 `pc` 为环头的自回跳循环；非法或冲突的标记只取消该优化。 */
  readonly markDirectLoop?: (pc: number, candidate: JitLoopCandidate) => void;
}
/** 影响本次翻译 IR 的借用代码字节区间，单位为所属 region 内的偏移。 */
export interface JitTranslationDependency {
  readonly offset: number;
  readonly length: number;
}
export interface JitTranslateInput extends JitDirectTimingInput {
  readonly pc: number;
  /** 仅在本次同步 translate 回调内有效；长度最多为本 region 的 `size`。 */
  readonly code: BorrowedBytes;
  /** 本次翻译所属 region 的逻辑基址；未命中 region 的服务 PC 回退主 code 时为 0。 */
  readonly codeBase: number;
  /** 按实例 memory 维护的代码代际；代码区域内的成功写入即时递增。 */
  readonly codeVersion: number;
  /**
   * 报告本次返回块中一个指令入口的连续取指字节范围，供 Direct JIT 判断不同逻辑
   * 窗口是否指向同一经验证的指令体。仅在同步 translate 回调期间有效；多次调用
   * 必须各自对应返回块中不同的指令入口。
   */
  readonly markDirectBodyShareable?: (pc: number, byteLength: number) => void;
  /**
   * 报告影响本次翻译 IR 的借用视图物理代码区间。运行时先确认偏移与长度均为非负安全
   * 整数且落在视图内；当前只校验，不保留借用视图。
   */
  readonly markTranslationDependencies?: (ranges: readonly JitTranslationDependency[]) => void;
}
export type JitTranslate = (input: JitTranslateInput, builder: JitBlockBuilder) => BlockIR;
export interface InstructionHook {
  readonly when: string;
  readonly call: string;
}
/**
 * 一条忙等延时环的声明：入口 `pc` 每轮把 number 状态 `counter` 减一，消耗 `cycles` ps。
 * 环内不得产生其他可观察效果，因此跳过多轮只推进时间、只留下最后一轮的效果。
 *
 * `pending` 给按累加器计时的外设（SysTick、USART 位时钟）：折算必须停在下一次服务边界，
 * 并把折叠掉的时间记进 `state`，否则跳过轮次会让这些外设永远等不到自己的节拍。
 */
export interface JitDelay {
  readonly counter: string;
  readonly cycles: number;
  readonly pending?: {
    /** 已累积的节拍时长（ps）。 */
    readonly state: string;
    /** 一次服务的粒度（ps）。 */
    readonly period: string;
    /** 是否需要按时间推进外设。 */
    readonly active: string;
  };
}

/**
 * A throughput-only wait point. When `predicate` is false the JIT parks until a dependency
 * changes. If `wait` is present, `delay` supplies the picoseconds to the next device time
 * event and `advance` applies that elapsed interval before the JIT is re-queued.
 *
 * `consume` runs once after `predicate` becomes true, allowing a one-shot wake token to be
 * cleared before the guest instruction executes. These functions take zero or one
 * argument; only `predicate` and `delay` must be pure.
 */
export interface JitPolling {
  readonly pc: number;
  readonly predicate: string;
  readonly consume?: string;
  readonly wait?: {
    /** Pure zero-argument function returning the delay in picoseconds, or zero to park. */
    readonly delay: string;
    /** Function receiving the elapsed picoseconds and applying the device time event. */
    readonly advance: string;
  };
}

/** 按 region 传给 codeMetadata provider 的只读代码视图；仅在本次同步回调内有效。 */
export interface JitCodeRegionView {
  readonly memory: string;
  readonly base: number;
  readonly size: number;
  readonly codeVersion: number;
  readonly code: BorrowedBytes;
}
/** 自上次该 region metadata 成功刷新以来的实际写入范围，单位为 memory offset；首次调用表示整区。 */
export interface JitCodeChange {
  readonly memory: string;
  readonly offset: number;
  readonly length: number;
}
export interface JitCodeMetadata {
  readonly polling: readonly JitPolling[];
  readonly delays: ReadonlyMap<number, JitDelay>;
}
export interface JitCodeMetadataInput {
  readonly region: JitCodeRegionView;
  readonly changes: readonly JitCodeChange[];
}
export type JitCodeMetadataProvider = (input: JitCodeMetadataInput) => JitCodeMetadata;

export interface JitOptions {
  readonly entry: string;
  readonly code: string;
  /**
   * 主 `code` 内存仍隐式提供 0 基址 region；这里追加 Flash alias、SRAM、CCM 等
   * 可执行区域。区域不得与隐式主区域或彼此重叠。
   */
  readonly codeRegions?: readonly JitCodeRegion[];
  /**
   * 按 region、按 codeVersion 懒加载的代码派生 metadata。与静态
   * `polling`/`delays` 互斥；省略时完全保持旧静态路径。
   */
  readonly codeMetadata?: JitCodeMetadataProvider;
  readonly pc: string;
  /** Return immutable synchronous function IR scoped to this JIT. Reuse its array to reuse binding. */
  readonly functions?: (
    device: DeviceIR,
  ) => readonly Extract<DeclarationIR, { kind: 'function' }>[];
  readonly beforeInstruction?: InstructionHook;
  readonly polling?: readonly JitPolling[];
  readonly delays?: ReadonlyMap<number, JitDelay>;
  /**
   * Direct 时间准入：`service` 指向本实例的定时服务 number 状态，`blocked` 指向安静条件。
   * 省略时不检查服务期限与安静条件，仅按宿主上限和其余准入条件优化。
   */
  readonly directTiming?: JitDirectTiming;
  /**
   * 启用 Direct 指令体共享：同步翻译期间提供 `markDirectBodyShareable`，并只把通过
   * 运行时校验的等价候选交给 Direct 会话。仅省略时为 false；关闭时所有入口独立执行。
   */
  readonly shareDirectBodies?: boolean;
  /**
   * 跨实例翻译工件身份：`abi` 标识生成器与融合规则，`configuration` 标识时钟及特化配置。
   * 省略时翻译结果只用于当前实例。
   */
  readonly translationIdentity?: { readonly abi: string; readonly configuration: string };
  /**
   * 两级 Direct 执行。省略时保持即时 Direct；设置后每个本地路由从共享通用级开始，
   * 成功完成的真实指令达到正安全整数 `promoteAfter` 后晋升。
   */
  readonly directTier?: { readonly promoteAfter: number };
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
  readonly execution?: 'throughput' | 'precise';
  /** CPU execution quantum in integer picoseconds, default 10_000_000. */
  readonly cpuQuantum?: number;
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
export class SimulationError extends Error {
  readonly code: RuntimeDiagnosticCode;
  readonly diagnostic: RuntimeDiagnostic;
  readonly related: readonly RuntimeDiagnostic[];
  constructor(diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message);
    this.name = 'SimulationError';
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
    this.related = diagnostic.related;
  }
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
