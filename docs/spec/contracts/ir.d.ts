/** 共享 IR 的内存合同；可解析的结构仍须经过类型、作用域、效果与绑定检查。 */

/** 行列从 1 开始，列按 UTF-16 代码单元计数。 */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** 左闭右开范围；结束位置不得早于开始位置。 */
export interface SourceRange {
  readonly start: Position;
  readonly end: Position;
}

/** 无源文件的生成代码可只提供标签；有源码位置时 URI 与范围必须同时存在。 */
export type SourceInfo =
  | { readonly uri: string; readonly range: SourceRange; readonly label?: string }
  | { readonly label: string; readonly uri?: never; readonly range?: never };

export type InputPath = readonly (string | number)[];
export type DiagnosticPhase = 'construct' | 'finalize' | 'bind';
export type DiagnosticCode =
  | 'IR_SCHEMA'
  | 'IR_TYPE'
  | 'IR_SCOPE'
  | 'IR_CONTROL_FLOW'
  | 'IR_EFFECT'
  | 'IR_REFERENCE'
  | 'IR_LIFECYCLE'
  | 'IR_DEPENDENCY'
  | 'IR_JIT_BOUNDARY';

export interface RelatedDiagnostic {
  readonly message: string;
  readonly path: InputPath;
  readonly source?: SourceInfo;
}

/** path 定位当前输入，source 定位原始来源；message 和相关说明使用英文。 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly phase: DiagnosticPhase;
  readonly path: InputPath;
  readonly source?: SourceInfo;
  readonly related: readonly RelatedDiagnostic[];
}

/** 追加操作及时失败，完成检查可汇总独立错误；任何失败都不交付部分可执行结果。 */
export declare class BuildError extends Error {
  readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  constructor(diagnostics: readonly [Diagnostic, ...Diagnostic[]]);
}

export interface Located {
  readonly source?: SourceInfo;
}

export type ComparablePlainTypeIR =
  | { readonly kind: 'number' | 'bool' | 'string' | 'bytes' | 'sample' }
  | { readonly kind: 'enum' | 'record'; readonly name: string };
export type PlainTypeIR = ComparablePlainTypeIR | { readonly kind: 'intent' };
export type ComparableTypeIR =
  ComparablePlainTypeIR | { readonly kind: 'optional'; readonly inner: ComparablePlainTypeIR };

/** 可空只嵌套一层；具体声明位置还须遵守 DDL 的类型适用范围。 */
export type ValueTypeIR = PlainTypeIR | { readonly kind: 'optional'; readonly inner: PlainTypeIR };

export type ParameterTypeIR = ValueTypeIR | { readonly kind: 'pin' | 'memory' };
/** 非负安全整数；在独立执行体或单条 JIT 指令内唯一，不是实例资源编号。 */
export type ResultId = number;
/** 与结果分开编号；编号相同不表示可以跨作用域共享局部槽。 */
export type LocalId = number;

/** parameter.index 指向当前函数参数表，必须核对资源类别；不会产生资源别名值。 */
export type PinRefIR =
  | { readonly kind: 'pin'; readonly name: string }
  | { readonly kind: 'parameter'; readonly resource: 'pin'; readonly index: number };

export type MemoryRefIR =
  | { readonly kind: 'memory'; readonly name: string }
  | { readonly kind: 'parameter'; readonly resource: 'memory'; readonly index: number };

export type TargetRefIR = PinRefIR;
export type ArgumentIR =
  { readonly kind: 'value'; readonly value: ResultId } | PinRefIR | MemoryRefIR;

/** 常量保留内存 number 语义，包括 NaN、无穷大与负零；sample 和 intent 不由常量伪造。 */
export type ConstantIR =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'enum'; readonly name: string; readonly member: string }
  | {
      readonly kind: 'record';
      readonly name: string;
      readonly fields: readonly { readonly name: string; readonly value: number | boolean }[];
    }
  | { readonly kind: 'bytes'; readonly value: readonly number[] };

export interface ResultIR {
  readonly result: ResultId;
  readonly type: ValueTypeIR;
}

/** 操作数组的顺序就是执行顺序；子区域不能向外泄露其临时结果编号。 */
export interface RegionIR extends Located {
  readonly operations: readonly OperationIR[];
}

/** 每条正常结束路径以 yield 交付结果；yield 不结束外层函数，也不让出调度。 */
export interface ValueRegionIR {
  readonly type: ValueTypeIR;
  readonly body: RegionIR;
}

/** 独立计算体使用 returnValue；创建期、derived 或 reaction capture 用途由声明决定。 */
export interface ComputationIR extends Located {
  readonly type: ValueTypeIR;
  readonly body: RegionIR;
}

/** 每个 capture 是独立纯计算体；只在响应体内按声明索引读取其结果。 */
export interface ReactionCaptureIR extends Located {
  readonly name: string;
  readonly value: ComputationIR & { readonly type: ComparableTypeIR };
}

export type UnaryOperator = 'positive' | 'negate' | 'not' | 'bitNot';
export type BinaryOperator =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'remainder'
  | 'power'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'equal'
  | 'notEqual'
  | 'concat'
  | 'bitAnd'
  | 'bitOr'
  | 'bitXor'
  | 'shiftLeft'
  | 'shiftRight'
  | 'shiftRightUnsigned';
export type NumericBuiltin =
  | 'isNaN'
  | 'isFinite'
  | 'isInteger'
  | 'isSafeInteger'
  | 'abs'
  | 'floor'
  | 'ceil'
  | 'trunc'
  | 'round'
  | 'sqrt'
  | 'min'
  | 'max'
  | 'pow';
export type LoadKind = 'load8' | 'load16le' | 'load16be' | 'load32le' | 'load32be';
export type StoreKind = 'store8' | 'store16le' | 'store16be' | 'store32le' | 'store32be';

export type MatchPatternIR =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly name: string; readonly member: string }
  | { readonly kind: 'none' };

export interface MatchArmIR extends Located {
  readonly pattern: MatchPatternIR;
  readonly body: RegionIR;
}

/**
 * 普通值输入全部为 ResultId，资源与局部槽使用各自字段。
 * 结果 type 和 call.pure 都是待核对信息，不能替代对实际节点及调用图的检查。
 * wait / elapse / redirect 的时间值均在执行到操作时读取，单位为整数皮秒。
 */
export type OperationIR = Located &
  (
    | (ResultIR & { readonly kind: 'constant'; readonly constant: ConstantIR })
    | (ResultIR & {
        readonly kind: 'read';
        readonly resource: 'property' | 'const' | 'state' | 'derived';
        readonly name: string;
      })
    | (ResultIR & { readonly kind: 'parameter'; readonly index: number })
    | (ResultIR & {
        readonly kind: 'reactionValue';
        readonly binding: 'previous' | 'current';
      })
    | (ResultIR & { readonly kind: 'reactionCapture'; readonly index: number })
    | (ResultIR & {
        readonly kind: 'unary';
        readonly operator: UnaryOperator;
        readonly value: ResultId;
      })
    | (ResultIR & {
        readonly kind: 'binary';
        readonly operator: BinaryOperator;
        readonly left: ResultId;
        readonly right: ResultId;
      })
    | (ResultIR & {
        readonly kind: 'numeric';
        readonly builtin: NumericBuiltin;
        readonly args: readonly ResultId[];
      })
    | (ResultIR & {
        readonly kind: 'record';
        readonly fields: readonly { readonly name: string; readonly value: ResultId }[];
      })
    | (ResultIR & { readonly kind: 'field'; readonly value: ResultId; readonly field: string })
    | (ResultIR & { readonly kind: 'bytes'; readonly elements: readonly ResultId[] })
    | (ResultIR & { readonly kind: 'length'; readonly value: ResultId })
    | (ResultIR & { readonly kind: 'index'; readonly value: ResultId; readonly index: ResultId })
    | (ResultIR & { readonly kind: 'optional'; readonly value: ResultId })
    | (ResultIR & { readonly kind: 'isNone'; readonly value: ResultId })
    | (ResultIR & { readonly kind: 'nonNull'; readonly value: ResultId })
    | (ResultIR & { readonly kind: 'localRead'; readonly local: LocalId })
    /** 声明执行时初始化；localRead 捕获一次值，localWrite 不会刷新已保存的旧结果。 */
    | {
        readonly kind: 'local';
        readonly local: LocalId;
        readonly type: ValueTypeIR;
        readonly initial: ResultId;
      }
    | { readonly kind: 'localWrite'; readonly local: LocalId; readonly value: ResultId }
    /** 执行处立即更新状态，后续 read 可见；不改变先前已捕获的结果。 */
    | {
        readonly kind: 'write';
        readonly resource: 'state';
        readonly name: string;
        readonly value: ResultId;
      }
    | (ResultIR & { readonly kind: 'memoryLength'; readonly memory: MemoryRefIR })
    | (ResultIR & {
        readonly kind: LoadKind;
        readonly memory: MemoryRefIR;
        readonly offset: ResultId;
      })
    | {
        readonly kind: StoreKind;
        readonly memory: MemoryRefIR;
        readonly offset: ResultId;
        readonly value: ResultId;
      }
    | (ResultIR & {
        readonly kind: 'copyBytes';
        readonly memory: MemoryRefIR;
        readonly offset: ResultId;
        readonly length: ResultId;
      })
    | (ResultIR & { readonly kind: 'readSample'; readonly pin: PinRefIR })
    | (ResultIR & {
        readonly kind: 'resistor';
        readonly to: TargetRefIR;
        readonly resistance: ResultId;
      })
    | (ResultIR & { readonly kind: 'combineIntents'; readonly values: readonly ResultId[] })
    | (ResultIR & {
        readonly kind: 'refEqual';
        readonly left: PinRefIR | MemoryRefIR;
        readonly right: PinRefIR | MemoryRefIR;
      })
    | { readonly kind: 'writeIntent'; readonly pin: PinRefIR; readonly value: ResultId }
    /** args 按形参顺序引用已求得结果；值的求值顺序由前序操作决定，pure 要核对实际目标。 */
    | {
        readonly kind: 'call';
        readonly name: string;
        readonly pure: boolean;
        readonly args: readonly ArgumentIR[];
      }
    | (ResultIR & {
        readonly kind: 'callValue';
        readonly name: string;
        readonly pure: boolean;
        readonly args: readonly ArgumentIR[];
      })
    | { readonly kind: 'send'; readonly channel: string; readonly value: ResultId }
    | { readonly kind: 'notify'; readonly notification: string }
    | (ResultIR & { readonly kind: 'receive'; readonly channel: string })
    | (ResultIR & { readonly kind: 'now' | 'random' })
    | {
        readonly kind: 'if';
        readonly condition: ResultId;
        readonly yes: RegionIR;
        readonly no?: RegionIR;
      }
    | {
        readonly kind: 'match';
        readonly value: ResultId;
        readonly arms: readonly MatchArmIR[];
        readonly otherwise?: RegionIR;
      }
    /** 条件每轮重算，允许当前上下文合法同步效果；continue 回到 test，条件不能挂起。 */
    | { readonly kind: 'while'; readonly test: ValueRegionIR; readonly body: RegionIR }
    | { readonly kind: 'loop'; readonly body: RegionIR }
    | (ResultIR & {
        readonly kind: 'and' | 'or';
        readonly left: ResultId;
        readonly right: ValueRegionIR;
      })
    | (ResultIR & {
        readonly kind: 'select';
        readonly condition: ResultId;
        readonly yes: ValueRegionIR;
        readonly no: ValueRegionIR;
      })
    | { readonly kind: 'assert'; readonly condition: ResultId; readonly message?: ValueRegionIR }
    | { readonly kind: 'wait' | 'elapse'; readonly duration: ResultId }
    /** 只在末条 JIT 指令尾路径出现；if / match 外层无后缀，循环或计算区域内拒绝。 */
    | { readonly kind: 'waitUntil'; readonly predicate: string }
    | { readonly kind: 'redirect'; readonly target: ResultId; readonly delay: ResultId }
    | { readonly kind: 'return' | 'break' | 'continue' | 'stop' }
    | { readonly kind: 'returnValue' | 'yield'; readonly value: ResultId }
  );

export interface ParameterIR extends Located {
  readonly name: string;
  readonly type: ParameterTypeIR;
}

/** 声明顺序用于稳定诊断与合同规定的初始化顺序；前向引用统一在完成阶段解析。 */
export type DeclarationIR = Located &
  (
    | { readonly kind: 'enum'; readonly name: string; readonly members: readonly string[] }
    | {
        readonly kind: 'record';
        readonly name: string;
        readonly fields: readonly { readonly name: string; readonly type: 'number' | 'bool' }[];
      }
    | {
        readonly kind: 'property';
        readonly name: string;
        readonly type: ValueTypeIR;
        readonly default?: ComputationIR;
      }
    | {
        readonly kind: 'const';
        readonly name: string;
        readonly type: ValueTypeIR;
        readonly value: ComputationIR;
      }
    | {
        readonly kind: 'state';
        readonly name: string;
        readonly type: ValueTypeIR;
        readonly initial: ComputationIR;
      }
    | {
        readonly kind: 'derived';
        readonly name: string;
        readonly type: ValueTypeIR;
        readonly value: ComputationIR;
      }
    | ({ readonly kind: 'pin'; readonly name: string } & (
        | { readonly low?: never; readonly high?: never }
        | { readonly low: ComputationIR; readonly high: ComputationIR }
      ))
    | {
        readonly kind: 'memory';
        readonly name: string;
        readonly public: boolean;
        readonly length: ComputationIR;
      }
    | {
        readonly kind: 'channel';
        readonly name: string;
        readonly direction: 'input' | 'output';
        readonly type: ValueTypeIR;
        readonly capacity: ComputationIR;
        readonly maxLength?: ComputationIR;
        readonly overflow?: ComputationIR;
      }
    | {
        readonly kind: 'notification';
        readonly name: string;
        readonly direction: 'input' | 'output';
      }
    | {
        readonly kind: 'function';
        readonly name: string;
        readonly pure: boolean;
        readonly params: readonly ParameterIR[];
        readonly returns?: ValueTypeIR;
        readonly body: RegionIR;
      }
    | { readonly kind: 'start'; readonly body: RegionIR }
    | {
        readonly kind: 'reaction';
        readonly name: string;
        readonly sourcePath: readonly [string, ...string[]];
        readonly sourceType: ComparableTypeIR;
        readonly previous: string;
        readonly current: string;
        readonly captures: readonly ReactionCaptureIR[];
        readonly body: RegionIR;
      }
    | {
        readonly kind: 'on';
        readonly name: string;
        readonly sourcePath: readonly string[];
        readonly body: RegionIR;
      }
    | { readonly kind: 'assert'; readonly body: RegionIR }
  );

export interface DeviceIR extends Located {
  readonly kind: 'device';
  readonly name: string;
  readonly declarations: readonly DeclarationIR[];
}

/** pc / nextPc 是有限 number，不要求整数或递增；每条指令拥有独立局部编号空间。 */
export interface InstructionIR extends Located {
  readonly pc: number;
  readonly nextPc: number;
  readonly body: RegionIR;
}

export interface BlockIR extends Located {
  readonly kind: 'block';
  readonly instructions: readonly InstructionIR[];
}

/** 校验自包含定义并捕获递归不可变快照；失败抛出 BuildError，阶段为 finalize。 */
export declare function validateDeviceIR(input: unknown): DeviceIR;
/** 校验块内结构；实际实例引用、入口与代码版本仍须在接纳块时绑定检查。 */
export declare function validateBlockIR(input: unknown): BlockIR;
