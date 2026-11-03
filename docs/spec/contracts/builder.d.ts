/** Builder 构造接口合同：调用生成 IR，不在构造期执行资源操作或推进仿真。 */
import type { BlockIR, DeviceIR, SourceInfo } from './ir';
export type { BlockIR, DeviceIR, SourceInfo } from './ir';

declare const typeTag: unique symbol;
declare const valueTag: unique symbol;
declare const localTag: unique symbol;
declare const enumTag: unique symbol;
declare const recordTag: unique symbol;
declare const bytesTag: unique symbol;
declare const intentTag: unique symbol;
declare const sampleTag: unique symbol;
declare const refTag: unique symbol;

/** 类型描述辅助 TS 推导；具名身份、定义归属及适用位置仍须由 IR 校验。 */
export interface Type<T> {
  readonly [typeTag]: T;
}
/** 一次执行结果的句柄，而非以后每次使用都会重新求值的表达式。 */
export interface Value<T> {
  readonly [valueTag]: T;
}
/** 可变局部槽显式读写；类型不变，且不得跨独立执行体或 JIT 指令使用。 */
export interface Local<T> {
  readonly [localTag]: (value: T) => T;
}
export interface EnumValue<N extends string, M extends string = string> {
  readonly [enumTag]: { readonly name: N; readonly member: M };
}
export type FieldShape = Readonly<Record<string, number | boolean>>;
export type RecordValue<N extends string, F extends FieldShape> = Readonly<F> & {
  readonly [recordTag]: { readonly name: N; readonly fields: F };
};
export interface BytesValue {
  readonly [bytesTag]: true;
}
export interface IntentValue {
  readonly [intentTag]: true;
}
/** 电气合同规定的完整采样状态集合。 */
export type SampleStatusMember = 'valid' | 'floating';
export interface SampleValue {
  readonly [sampleTag]: true;
  readonly voltage: number | null;
  readonly level: EnumValue<'Logic', 'low' | 'high' | 'unknown'>;
  readonly status: EnumValue<'SampleStatus', SampleStatusMember>;
}
export type RuntimeValue =
  | number
  | boolean
  | string
  | null
  | EnumValue<string>
  | RecordValue<string, FieldShape>
  | BytesValue
  | IntentValue
  | SampleValue;
export type ComparableValue = Exclude<RuntimeValue, IntentValue>;
/** 记录接受目标类型的字段对象；bytes 输入会复制。sample 与 intent 不能伪造宿主常量。 */
export type Constant<T> = T extends IntentValue | SampleValue
  ? never
  : T extends BytesValue
    ? Uint8Array | readonly number[]
    : T extends RecordValue<string, infer F>
      ? Readonly<F>
      : T;
export type Operand<T> = Value<T> | Constant<T>;
export type Infer<T> = T extends Type<infer V> ? V : never;

export interface EnumType<N extends string, M extends readonly string[]> extends Type<
  EnumValue<N, M[number]>
> {
  readonly name: N;
  readonly members: { readonly [K in M[number]]: EnumValue<N, K> };
}
export type RecordFields = Readonly<Record<string, Type<number> | Type<boolean>>>;
export type FieldValues<F extends RecordFields> = {
  readonly [K in keyof F]: Infer<F[K]>;
};
export interface RecordType<N extends string, F extends RecordFields> extends Type<
  RecordValue<N, FieldValues<F>>
> {
  readonly name: N;
  readonly fields: F;
}

/** 引用仅标识本实例资源，不是普通值；不能保存到 Local、记录或作为返回值。 */
export interface PinRef {
  readonly [refTag]: 'pin';
}
export interface MemoryRef {
  readonly [refTag]: 'memory';
}
export type PinInput = string | PinRef;
export type MemoryInput = string | MemoryRef;
export type TargetInput = PinInput;
export interface PinParameterType {
  readonly kind: 'pin';
}
export interface MemoryParameterType {
  readonly kind: 'memory';
}
export type ParameterType = Type<RuntimeValue> | PinParameterType | MemoryParameterType;
export type Argument = Operand<RuntimeValue> | PinRef | MemoryRef;

export interface TypeFactory {
  readonly number: Type<number>;
  readonly bool: Type<boolean>;
  readonly string: Type<string>;
  readonly bytes: Type<BytesValue>;
  readonly intent: Type<IntentValue>;
  readonly sample: Type<SampleValue>;
  readonly pin: PinParameterType;
  readonly memory: MemoryParameterType;
  readonly logic: EnumType<'Logic', readonly ['low', 'high', 'unknown']>;
  /** 浮空为正常采样状态；数值求解失败通过板级故障报告。 */
  readonly sampleStatus: EnumType<'SampleStatus', readonly ['valid', 'floating']>;
  readonly overflow: EnumType<'Overflow', readonly ['drop_new', 'drop_oldest', 'error']>;
  /** 单层可空；null 常量必须有此类目标类型，不能独立推断具名类型。 */
  optional<T extends Exclude<RuntimeValue, null>>(type: Type<T>): Type<T | null>;
  /** 前向引用携带预期结构，完成时核对实际声明及定义归属。 */
  namedEnum<const N extends string, const M extends readonly [string, ...string[]]>(
    name: N,
    members: M,
  ): EnumType<N, M>;
  namedRecord<const N extends string, const F extends RecordFields>(
    name: N,
    fields: F,
  ): RecordType<N, F>;
}
export declare const types: TypeFactory;

/** 仅设置默认来源，不新增 IR 操作或局部作用域；退出后恢复外层来源。 */
export interface SourceScope<Self> {
  withSource(source: SourceInfo, emit: (body: Self) => void): void;
}

/** 所有操作按生成位置执行；普通数值运算保留语言规范的 binary64 和 32 位位运算语义。 */
export interface ValueOps {
  constant<T extends RuntimeValue>(type: Type<T>, value: NoInfer<Constant<T>>): Value<T>;
  readProperty<T extends RuntimeValue>(name: string, type: Type<T>): Value<T>;
  readConst<T extends RuntimeValue>(name: string, type: Type<T>): Value<T>;
  getLocal<T extends RuntimeValue>(local: Local<T>): Value<T>;
  positive(value: Operand<number>): Value<number>;
  negate(value: Operand<number>): Value<number>;
  not(value: Operand<boolean>): Value<boolean>;
  bitNot(value: Operand<number>): Value<number>;
  add(left: Operand<number>, right: Operand<number>): Value<number>;
  subtract(left: Operand<number>, right: Operand<number>): Value<number>;
  multiply(left: Operand<number>, right: Operand<number>): Value<number>;
  divide(left: Operand<number>, right: Operand<number>): Value<number>;
  remainder(left: Operand<number>, right: Operand<number>): Value<number>;
  power(left: Operand<number>, right: Operand<number>): Value<number>;
  lessThan(left: Operand<number>, right: Operand<number>): Value<boolean>;
  lessThanOrEqual(left: Operand<number>, right: Operand<number>): Value<boolean>;
  greaterThan(left: Operand<number>, right: Operand<number>): Value<boolean>;
  greaterThanOrEqual(left: Operand<number>, right: Operand<number>): Value<boolean>;
  /** 按目标类型比较，intent 拒绝内容相等；具名记录、枚举及可空值另做语义校验。 */
  equal<T extends RuntimeValue>(
    type: Type<T>,
    left: NoInfer<Operand<T>>,
    right: NoInfer<Operand<T>>,
  ): Value<boolean>;
  notEqual<T extends RuntimeValue>(
    type: Type<T>,
    left: NoInfer<Operand<T>>,
    right: NoInfer<Operand<T>>,
  ): Value<boolean>;
  concat(left: Operand<string>, right: Operand<string>): Value<string>;
  bitAnd(left: Operand<number>, right: Operand<number>): Value<number>;
  bitOr(left: Operand<number>, right: Operand<number>): Value<number>;
  bitXor(left: Operand<number>, right: Operand<number>): Value<number>;
  shiftLeft(left: Operand<number>, right: Operand<number>): Value<number>;
  shiftRight(left: Operand<number>, right: Operand<number>): Value<number>;
  shiftRightUnsigned(left: Operand<number>, right: Operand<number>): Value<number>;
  isNaN(value: Operand<number>): Value<boolean>;
  isFinite(value: Operand<number>): Value<boolean>;
  isInteger(value: Operand<number>): Value<boolean>;
  isSafeInteger(value: Operand<number>): Value<boolean>;
  abs(value: Operand<number>): Value<number>;
  floor(value: Operand<number>): Value<number>;
  ceil(value: Operand<number>): Value<number>;
  trunc(value: Operand<number>): Value<number>;
  round(value: Operand<number>): Value<number>;
  sqrt(value: Operand<number>): Value<number>;
  min(left: Operand<number>, right: Operand<number>): Value<number>;
  max(left: Operand<number>, right: Operand<number>): Value<number>;
  pow(base: Operand<number>, exponent: Operand<number>): Value<number>;
  record<const N extends string, const F extends RecordFields>(
    type: RecordType<N, F>,
    fields: { readonly [K in keyof F]: Operand<Infer<F[K]>> },
  ): Value<RecordValue<N, FieldValues<F>>>;
  field<
    T extends SampleValue | RecordValue<string, FieldShape>,
    K extends Exclude<keyof T, symbol>,
  >(
    value: Value<T>,
    field: K,
  ): Value<T[K]>;
  bytes(...elements: Operand<number>[]): Value<BytesValue>;
  length(value: Value<string | BytesValue>): Value<number>;
  index(value: Value<string>, index: Operand<number>): Value<string>;
  index(value: Value<BytesValue>, index: Operand<number>): Value<number>;
  optional<T extends Exclude<RuntimeValue, null>>(value: Value<T>): Value<T | null>;
  isNone<T extends RuntimeValue>(value: Value<T | null>): Value<boolean>;
  /** 仅接受当前路径已证明非空的值；无证明时拒绝构造，不插入强制解包检查。 */
  nonNull<T extends Exclude<RuntimeValue, null>>(value: Value<T | null>): Value<T>;
  /** 目标必须显式声明 pure fn；创建期还要验证调用链不读取运行资源。 */
  callPure(name: string, ...args: Argument[]): void;
  callPureValue<T extends RuntimeValue>(
    name: string,
    result: Type<T>,
    ...args: Argument[]
  ): Value<T>;
}

/** 引用按名称延迟解析，允许指向同一定义中后声明的 pin。 */
export interface PinIntentOps {
  pin(name: string): PinRef;
  /** 生成引脚间电阻构造；执行时校验闭区间 [0.001, 1e9] Ω。 */
  resistor(to: TargetInput, resistance: Operand<number>): Value<IntentValue>;
  combineIntents(...values: Operand<IntentValue>[]): Value<IntentValue>;
}

export interface ReadOps extends ValueOps, PinIntentOps {
  /** 捕获执行处的当前状态值；此前的 writeState 已即时生效。 */
  readState<T extends RuntimeValue>(name: string, type: Type<T>): Value<T>;
  readDerived<T extends RuntimeValue>(name: string, type: Type<T>): Value<T>;
  memory(name: string): MemoryRef;
  memoryLength(memory: MemoryInput): Value<number>;
  load8(memory: MemoryInput, offset: Operand<number>): Value<number>;
  load16le(memory: MemoryInput, offset: Operand<number>): Value<number>;
  load16be(memory: MemoryInput, offset: Operand<number>): Value<number>;
  load32le(memory: MemoryInput, offset: Operand<number>): Value<number>;
  load32be(memory: MemoryInput, offset: Operand<number>): Value<number>;
  copyBytes(
    memory: MemoryInput,
    offset: Operand<number>,
    length: Operand<number>,
  ): Value<BytesValue>;
  readSample(pin: PinInput): Value<SampleValue>;
  refEqual(left: PinRef, right: PinRef): Value<boolean>;
  refEqual(left: MemoryRef, right: MemoryRef): Value<boolean>;
}

/** 普通同步计算允许 void，但生成路径必须全部终结；纯与创建期计算仍须返回 Operand。 */
export type ComputeResult<
  Compute extends ValueOps,
  T extends RuntimeValue,
> = Compute extends RuntimeEffects ? Operand<T> | void : Operand<T>;

/** 回调在构造期运行一次；生成的计算区域只在对应运行路径求值，不允许挂起。 */
export interface LazyOps<Compute extends ValueOps> {
  and(
    left: Operand<boolean>,
    right: (body: Compute) => ComputeResult<Compute, boolean>,
  ): Value<boolean>;
  or(
    left: Operand<boolean>,
    right: (body: Compute) => ComputeResult<Compute, boolean>,
  ): Value<boolean>;
  select<T extends RuntimeValue>(
    type: Type<T>,
    condition: Operand<boolean>,
    yes: (body: Compute) => NoInfer<ComputeResult<Compute, T>>,
    no: (body: Compute) => NoInfer<ComputeResult<Compute, T>>,
  ): Value<T>;
}

export type MatchPattern<T> = T extends number | string | boolean | null | EnumValue<string>
  ? T
  : never;
export interface MatchArm<T, Self> {
  readonly pattern: MatchPattern<T>;
  readonly emit: (body: Self) => void;
}
export interface ControlFlow<Self, Test extends ValueOps> extends SourceScope<Self> {
  local<T extends RuntimeValue>(type: Type<T>, initial: NoInfer<Operand<T>>): Local<T>;
  setLocal<T extends RuntimeValue>(local: Local<T>, value: NoInfer<Operand<T>>): void;
  if(condition: Operand<boolean>, yes: (body: Self) => void, no?: (body: Self) => void): void;
  match<T extends RuntimeValue>(
    value: Value<T>,
    arms: readonly NoInfer<MatchArm<T, Self>>[],
    otherwise?: (body: Self) => void,
  ): void;
  /** 每轮重算条件；条件允许所在上下文合法的同步效果，但不能等待或跳转外层循环。 */
  while(test: (body: Test) => ComputeResult<Test, boolean>, emit: (body: Self) => void): void;
  loop(emit: (body: Self) => void): void;
  break(): void;
  continue(): void;
}
/** 消息回调生成惰性区域，运行时只在条件为 false 时计算消息。 */
export interface Assertions<Compute extends ValueOps> {
  assert(
    condition: Operand<boolean>,
    message?: (body: Compute) => ComputeResult<Compute, string>,
  ): void;
}

export interface CreationStatements<Self>
  extends
    ValueOps,
    ControlFlow<Self, CreationCompute>,
    LazyOps<CreationCompute>,
    Assertions<CreationCompute> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 保留具名的递归能力视图。
export interface CreationCompute extends CreationStatements<CreationCompute> {}
export interface CreationBody<T extends RuntimeValue> extends CreationStatements<CreationBody<T>> {
  returnValue(value: Operand<T>): void;
}
/** 构造回调产生创建期 IR，不是实例创建时执行的任意宿主 JS；正常路径须 returnValue。 */
export type CreationInput<T extends RuntimeValue> = Constant<T> | ((body: CreationBody<T>) => void);

/** pin.initial 专用能力；嵌套计算保持相同的创建期限制。 */
export interface InitialIntentStatements<Self>
  extends
    ValueOps,
    PinIntentOps,
    ControlFlow<Self, InitialIntentCompute>,
    LazyOps<InitialIntentCompute>,
    Assertions<InitialIntentCompute> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 保留具名的递归能力视图。
export interface InitialIntentCompute extends InitialIntentStatements<InitialIntentCompute> {}
export interface InitialIntentBody extends InitialIntentStatements<InitialIntentBody> {
  returnValue(value: Operand<IntentValue>): void;
}

export interface PureStatements<Self>
  extends ReadOps, ControlFlow<Self, PureCompute>, LazyOps<PureCompute>, Assertions<PureCompute> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 保留具名的递归能力视图。
export interface PureCompute extends PureStatements<PureCompute> {}
export interface PureVoidFunctionBody extends PureStatements<PureVoidFunctionBody> {
  return(): void;
}
export interface PureValueFunctionBody<T extends RuntimeValue> extends PureStatements<
  PureValueFunctionBody<T>
> {
  returnValue(value: Operand<T>): void;
}

/** 字符串目标无法静态推断声明类型；绑定时核对实际资源、消息负载与调用签名。 */
export interface RuntimeEffects {
  /** 执行处立即更新状态，不等待同步片段结束或延迟提交。 */
  writeState<T extends RuntimeValue>(name: string, value: Operand<T>): void;
  store8(memory: MemoryInput, offset: Operand<number>, value: Operand<number>): void;
  store16le(memory: MemoryInput, offset: Operand<number>, value: Operand<number>): void;
  store16be(memory: MemoryInput, offset: Operand<number>, value: Operand<number>): void;
  store32le(memory: MemoryInput, offset: Operand<number>, value: Operand<number>): void;
  store32be(memory: MemoryInput, offset: Operand<number>, value: Operand<number>): void;
  writeIntent(pin: PinInput, value: Operand<IntentValue>): void;
  call(name: string, ...args: Argument[]): void;
  callValue<T extends RuntimeValue>(name: string, result: Type<T>, ...args: Argument[]): Value<T>;
  send<T extends RuntimeValue>(channel: string, value: Operand<T>): void;
  notify(notification: string): void;
  /** 执行处读取板级整数皮秒，不推进时间；不能跨挂起复用旧读取。 */
  now(): Value<number>;
  /** 消耗本实例随机序列；不能消除、提前执行或重排调用。 */
  random(): Value<number>;
}
export interface RedirectEffect {
  /** 终结当前路径并跨辅助调用层转向；delay 默认零，单位皮秒，目标须为有限数值。 */
  redirect(target: Operand<number>, delay?: Operand<number>): void;
}
export interface RuntimeStatements<Self, Compute extends ValueOps>
  extends
    ReadOps,
    ControlFlow<Self, Compute>,
    LazyOps<Compute>,
    Assertions<Compute>,
    RuntimeEffects {}
export interface SyncCompute extends RuntimeStatements<SyncCompute, SyncCompute>, RedirectEffect {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 保留具名的递归能力视图。
export interface ProcessCompute extends RuntimeStatements<ProcessCompute, ProcessCompute> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 保留 reaction 专用的递归能力视图。
export interface ReactionCompute extends RuntimeStatements<ReactionCompute, ReactionCompute> {}
/** 同步响应体可产生普通效果；不提供等待、接收或控制转向。 */
export interface ReactionBody extends RuntimeStatements<ReactionBody, ReactionCompute> {
  return(): void;
}
export interface ReactionCaptureBody<T extends ComparableValue> extends PureStatements<
  ReactionCaptureBody<T>
> {
  returnValue(value: Operand<T>): void;
}
/** 无值函数仅提供 return，有值函数仅提供 returnValue；JS 自身 return 不生成该操作。 */
export interface VoidFunctionBody
  extends RuntimeStatements<VoidFunctionBody, SyncCompute>, RedirectEffect {
  return(): void;
}
export interface ValueFunctionBody<T extends RuntimeValue>
  extends RuntimeStatements<ValueFunctionBody<T>, SyncCompute>, RedirectEffect {
  returnValue(value: Operand<T>): void;
}
export interface ProcessBody extends RuntimeStatements<ProcessBody, ProcessCompute> {
  /** 在执行处捕获时长并按整数皮秒校验；实际挂起才结束当前同步片段。 */
  wait(duration: Operand<number>): void;
  /** 只绑定 input channel；非空立即完成，空队列才挂起。 */
  receive<T extends RuntimeValue>(channel: string, type: Type<T>): Value<T>;
  return(): void;
}
export interface JitInstructionBuilder
  extends RuntimeStatements<JitInstructionBuilder, SyncCompute>, RedirectEffect {
  /** 显式耗时阶段，执行到该处捕获动态时长，等待期间不随资源变化重新计算。 */
  elapse(duration: Operand<number>): void;
  /** 绑定无参 bool pure fn；仅指令及块的尾路径允许，循环内拒绝。 */
  waitUntil(predicate: string): void;
  /** 终结路径并停止当前注册；新板独立注册，不同于结束块构造的 finish。 */
  stop(): void;
}

export interface Parameter {
  readonly name: string;
  readonly type: ParameterType;
}
/** 数组顺序决定调用位置，回调按参数名取得句柄；重名、遮蔽及归属另由完成检查验证。 */
export type ParameterBindings<P extends readonly Parameter[]> = {
  readonly [K in P[number] as K['name']]: K['type'] extends Type<infer V>
    ? Value<V>
    : K['type'] extends PinParameterType
      ? PinRef
      : MemoryRef;
};
export interface FunctionOptions<P extends readonly Parameter[]> {
  readonly name: string;
  readonly params: P;
  readonly source?: SourceInfo;
}
export interface NamedOptions {
  readonly name: string;
  readonly source?: SourceInfo;
}
export interface ReactionCapture {
  readonly name: string;
  readonly type: Type<ComparableValue>;
  readonly source?: SourceInfo;
}
export type ReactionCaptureEmitters<C extends readonly ReactionCapture[]> = {
  readonly [P in C[number] as P['name']]: (body: ReactionCaptureBody<Infer<P['type']>>) => void;
};
export interface ReactionBindings<T extends ComparableValue, C extends readonly ReactionCapture[]> {
  readonly previous: Value<T>;
  readonly current: Value<T>;
  readonly captures: {
    readonly [P in C[number] as P['name']]: Value<Infer<P['type']>>;
  };
}
export interface ReactionOptions<
  T extends ComparableValue,
  C extends readonly ReactionCapture[],
> extends NamedOptions {
  readonly sourcePath: readonly [string, ...string[]];
  readonly sourceType: Type<T>;
  readonly previous: string;
  readonly current: string;
  readonly captures: C;
}
export interface PropertyOptions<T extends RuntimeValue> extends NamedOptions {
  readonly type: Type<T>;
  readonly default?: NoInfer<CreationInput<T>>;
}
export interface InitialOptions<T extends RuntimeValue> extends NamedOptions {
  readonly type: Type<T>;
  readonly initial: NoInfer<CreationInput<T>>;
}
export interface ConstantOptions<T extends RuntimeValue> extends NamedOptions {
  readonly type: Type<T>;
  readonly value: NoInfer<CreationInput<T>>;
}
export type PinOptions = NamedOptions & { readonly initial?: (body: InitialIntentBody) => void } & (
    | { readonly low?: never; readonly high?: never }
    | { readonly low: CreationInput<number>; readonly high: CreationInput<number> }
  );
export interface MemoryOptions extends NamedOptions {
  readonly public?: boolean;
  readonly length: CreationInput<number>;
}
export interface ChannelOptions<T extends RuntimeValue> extends NamedOptions {
  readonly direction: 'input' | 'output';
  readonly type: Type<T>;
  readonly capacity: CreationInput<number>;
  readonly overflow?: CreationInput<EnumValue<'Overflow', 'drop_new' | 'drop_oldest' | 'error'>>;
  readonly maxLength?: CreationInput<number>;
}
/** 静态声明可前向引用；回调结束即关闭其体 Builder，完成或失败后关闭整个定义 Builder。 */
export interface DeviceBuilder extends SourceScope<DeviceBuilder> {
  enum<const N extends string, const M extends readonly [string, ...string[]]>(options: {
    readonly name: N;
    readonly members: M;
    readonly source?: SourceInfo;
  }): EnumType<N, M>;
  record<const N extends string, const F extends RecordFields>(options: {
    readonly name: N;
    readonly fields: F;
    readonly source?: SourceInfo;
  }): RecordType<N, F>;
  property<T extends RuntimeValue>(options: PropertyOptions<T>): void;
  constant<T extends RuntimeValue>(options: ConstantOptions<T>): void;
  state<T extends RuntimeValue>(options: InitialOptions<T>): void;
  derived<T extends RuntimeValue>(
    options: NamedOptions & { readonly type: Type<T> },
    emit: (body: NoInfer<PureValueFunctionBody<T>>) => void,
  ): void;
  pin(options: PinOptions): void;
  memory(options: MemoryOptions): void;
  channel<T extends RuntimeValue>(options: ChannelOptions<T>): void;
  notification(options: NamedOptions & { readonly direction: 'input' | 'output' }): void;
  fn<const P extends readonly Parameter[]>(
    options: FunctionOptions<P> & { readonly returns?: never },
    emit: (body: VoidFunctionBody, args: ParameterBindings<P>) => void,
  ): void;
  fn<const P extends readonly Parameter[], T extends RuntimeValue>(
    options: FunctionOptions<P> & { readonly returns: Type<T> },
    emit: (body: ValueFunctionBody<T>, args: ParameterBindings<P>) => void,
  ): void;
  pureFn<const P extends readonly Parameter[]>(
    options: FunctionOptions<P> & { readonly returns?: never },
    emit: (body: PureVoidFunctionBody, args: ParameterBindings<P>) => void,
  ): void;
  pureFn<const P extends readonly Parameter[], T extends RuntimeValue>(
    options: FunctionOptions<P> & { readonly returns: Type<T> },
    emit: (body: PureValueFunctionBody<T>, args: ParameterBindings<P>) => void,
  ): void;
  start(emit: (body: ProcessBody) => void): void;
  on(
    options: NamedOptions & { readonly sourcePath: readonly [string, ...string[]] },
    emit: (body: ProcessBody) => void,
  ): void;
  /** capture 回调各自生成独立纯计算体；响应参数为生成的 IR 结果句柄。 */
  reaction<T extends ComparableValue, const C extends readonly ReactionCapture[]>(
    options: ReactionOptions<T, C>,
    capture: NoInfer<ReactionCaptureEmitters<C>>,
    emit: (body: ReactionBody, bindings: NoInfer<ReactionBindings<T, C>>) => void,
  ): void;
  assert(emit: (body: CreationCompute) => void): void;
  finish(): DeviceIR;
}
export declare function createDeviceBuilder(options: NamedOptions): DeviceBuilder;

export interface InstructionBoundary {
  readonly pc: number;
  readonly nextPc: number;
  readonly source?: SourceInfo;
}
/** 仅由当前实例的翻译上下文提供，不能通过此视图新增资源或入口。 */
export interface JitBlockBuilder extends SourceScope<JitBlockBuilder> {
  instruction(boundary: InstructionBoundary, emit: (body: JitInstructionBuilder) => void): void;
  finish(): BlockIR;
}
