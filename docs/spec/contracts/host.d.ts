/** 宿主与器件 SDK 合同；行为与校验规则见对应规范正文。 */
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

/** 一段可执行代码区域；`base` 是逻辑 PC 基址，区域从对应 memory 的偏移 0 开始。 */
export interface JitCodeRegion {
  readonly memory: string;
  readonly base: number;
  readonly size: number;
}
/**
 * Direct 时间准入声明；`service` 引用已声明的 number 状态，`blocked` 引用已声明、
 * 无参且返回 bool 的 pure fn。`blocked` 仅在同时声明 `service` 时有效。
 */
export interface JitDirectTiming {
  /**
   * 定时服务状态名：`elapsed` 是自同一上次结算点起的已累计量，`deadline` 是该时点的期限，
   * 单位均为 ps；`deadline` 为 0 表示当前无定时服务。两项须指向已声明的 number 状态，
   * 未知名称或类别不符时注册以 `INVALID_BINDING` 拒绝；运行时两项须为非负安全整数，
   * 否则候选使用普通指令路径。
   */
  readonly service?: {
    /** 已声明的 number 状态；自同一上次结算点起的已累计时间，单位 ps。 */
    readonly elapsed: string;
    /** 已声明的 number 状态；自同一上次结算点起的期限，单位 ps；0 表示无定时服务。 */
    readonly deadline: string;
  };
  /**
   * 已声明的无参 bool `pure fn`，须同步、确定、不抛错且只读。缺少 `service`、未知名称、
   * 类别或签名不符时注册以 `INVALID_BINDING` 拒绝。求值为 true 时该逻辑 PC 使用普通
   * 指令路径；编译器沿调用图证明守卫。
   */
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
/** 仅当注册提供 `directTiming` 时提供的 Direct 时间候选标记；仅本次 `translate` 回调内有效。 */
export interface JitDirectTimingInput {
  /**
   * 标记返回块中从 `pc` 起、共 `instructionCount`（2–8）条连续指令组成的合块：纯定长
   * 前缀后接一条普通 GPIO/SFR 终结写。前缀各条 `nextPc` 须等于下一条成员 PC；终结写
   * 及各后续 PC 保留普通路由。非法、重复或无法证明的标记只取消该优化。
   */
  readonly markDirectSpan?: (pc: number, instructionCount: number) => void;
  /**
   * 标记以 `pc` 为环头的自回跳循环。候选仅在吞吐模式、主代码内存与当前单 JIT Direct
   * 准入条件下消费，并由规范 IR 证明轮时长、退出条件、读写集合与尾部时间账。
   */
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
   * 报告影响本次翻译 IR 的借用视图物理代码区间。运行时须先确认偏移与长度均为非负安全
   * 整数且落在视图内，并在缓存前快照或按内容比较这些字节；空区间只用于已证明与代码
   * 字节无关的虚拟入口。
   */
  readonly markTranslationDependencies?: (ranges: readonly JitTranslationDependency[]) => void;
}
export type JitTranslate = (input: JitTranslateInput, builder: JitBlockBuilder) => BlockIR;
export interface InstructionHook {
  readonly when: string;
  readonly call: string;
}
export interface JitPolling {
  readonly pc: number;
  readonly predicate: string;
  /** 谓词成立后、指令执行前调用一次的无参无返回函数。 */
  readonly consume?: string;
  /** 设备时间事件；delay 返回 ps，advance 在事件到期后应用该时长。 */
  readonly wait?: {
    readonly delay: string;
    readonly advance: string;
  };
}
/** 忙等延时环声明；`pending` 用于按累加器计时的外设。 */
export interface JitDelay {
  readonly counter: string;
  readonly cycles: number;
  readonly pending?: {
    readonly state: string;
    readonly period: string;
    readonly active: string;
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
/** 自上次该 region metadata 成功刷新以来的实际写入范围，单位为 memory offset。首次调用表示整区 `[0,size]`；同字节非空写也包含。 */
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
  /** 追加可执行区域；主 `code` 仍隐式提供 0 基址 region。静态 polling/delays 不随 codeVersion 重新声明。 */
  readonly codeRegions?: readonly JitCodeRegion[];
  /** 按 region/codeVersion 懒加载的 metadata；与静态 polling/delays 互斥。 */
  readonly codeMetadata?: JitCodeMetadataProvider;
  readonly pc: string;
  readonly beforeInstruction?: InstructionHook;
  /** 有限且互异的 PC；predicate 绑定本实例无参 bool pure fn，声明循环头的等待语义。 */
  readonly polling?: readonly JitPolling[];
  /**
   * 忙等延时环声明：键为环头 PC，`counter` 是每轮减一的 number 状态，`cycles` 是一轮消耗的 ps。
   * 环内除该递减外无可观察效果；运行时按时间窗折叠轮次，最后一轮仍正常执行。
   */
  readonly delays?: ReadonlyMap<number, JitDelay>;
  /**
   * Direct 时间准入：`service` 指向已声明的定时服务 number 状态，`blocked` 指向已声明的
   * 安静 pure fn；`blocked` 须与 `service` 同时声明。省略时不提供时间候选标记，也不进行
   * 服务/安静准入，普通 Direct 仍按宿主上限执行。守卫为真、定时状态非法或形状无法证明时
   * 使用普通指令路径。
   */
  readonly directTiming?: JitDirectTiming;
  /**
   * 启用 Direct 指令体共享：同步翻译期间提供 `markDirectBodyShareable`，并只把通过
   * 运行时校验的等价候选交给 Direct 会话。仅省略时为 false；关闭时所有入口独立执行。
   */
  readonly shareDirectBodies?: boolean;
  /**
   * 启用跨实例 Direct 编译工件共享：显式 `true` 时，同进程中的注册共享有界的指令模板与
   * 分片工厂缓存。省略或 `false` 时，每个注册使用独立工件缓存，只在本注册内复用，
   * 保持原生产默认。
   */
  readonly shareDirectArtifacts?: boolean;
  /**
   * 跨实例翻译工件身份：`abi` 标识生成器与融合规则，`configuration` 标识时钟及特化配置。
   * 设置后，符合该身份与依赖字节的不可变工件 MAY 跨实例复用；省略时翻译结果只用于
   * 当前实例。依赖字节另由 `markTranslationDependencies` 报告。
   */
  readonly translationIdentity?: { readonly abi: string; readonly configuration: string };
  /**
   * 两级 Direct 执行。省略时保持即时 Direct；设置后每个本地路由从共享通用级开始，
   * 成功完成的真实指令达到正安全整数 `promoteAfter` 后晋升。暂停或失效的后缀、
   * 元数据刷新、轮询及折叠跳过的轮次不计数；字节写入、IR 重叠或编译上下文变化
   * 先撤销旧路由与晋升状态。
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
  /** 仅省略时默认为 throughput；precise 保留逐指令边界调度。 */
  readonly execution?: 'throughput' | 'precise';
  /** 整数 ps，范围 1..10_000_000，省略为 10_000_000；precise 仍校验但不使用。 */
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
