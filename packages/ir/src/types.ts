/**
 * Domain-independent IR types and author-facing builder interfaces.
 *
 * The in-memory representation in this package is not a frozen persistence
 * format; only the explicit builder and declaration contracts below are public.
 */

export const SCALAR_TYPES = ['bool', 'u8', 'u16', 'u32', 'i8', 'i16', 'i32', 'f32', 'f64'] as const;

export type ScalarType = (typeof SCALAR_TYPES)[number];

export const INTEGER_TYPES = ['u8', 'u16', 'u32', 'i8', 'i16', 'i32'] as const;
export type IntegerType = (typeof INTEGER_TYPES)[number];

export const SIGNED_INTEGER_TYPES = ['i8', 'i16', 'i32'] as const;
export type SignedIntegerType = (typeof SIGNED_INTEGER_TYPES)[number];

export const FLOAT_TYPES = ['f32', 'f64'] as const;
export type FloatType = (typeof FLOAT_TYPES)[number];

export const NUMERIC_TYPES = [...INTEGER_TYPES, ...FLOAT_TYPES] as const;
export type NumericType = IntegerType | FloatType;

export type Predicate = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';
export type Endian = 'little' | 'big';
export type HexBits = `0x${string}`;

export type JSScalar<T extends ScalarType> = T extends 'bool' ? boolean : number;

/** Exact floating data for movement; never decode/re-encode a NaN to copy it. */
export interface FloatBits {
  readonly type: FloatType;
  readonly bits: HexBits;
}

export type RuntimeScalar = boolean | number | FloatBits;

export type ScalarArgs<P extends readonly ScalarType[]> = {
  readonly [I in keyof P]: JSScalar<P[I]>;
};

// Brand keys keep handle categories nominally distinct without making their
// runtime layout part of the public contract.
export const refKind: unique symbol = Symbol('mica.ir.ref-kind');
export const scalarType: unique symbol = Symbol('mica.ir.scalar-type');
export const signature: unique symbol = Symbol('mica.ir.signature');
export const byteReadonly: unique symbol = Symbol('mica.ir.byte-readonly');
export const valueKind: unique symbol = Symbol('mica.ir.value-kind');

export interface StaticRef<K extends string = string> {
  readonly [refKind]: K;
}

export interface Value<T extends ScalarType = ScalarType> {
  readonly [valueKind]: 'ssa-value';
  readonly type: T;
}

export type Values<P extends readonly ScalarType[]> = {
  readonly [I in keyof P]: Value<P[I]>;
};

export interface StateRef<T extends ScalarType = ScalarType> extends StaticRef<'state'> {
  readonly [scalarType]: T;
}

export interface ArrayRef<T extends ScalarType = ScalarType> extends StaticRef<'array'> {
  readonly [scalarType]: T;
}

export interface BytesRef<ReadonlyBytes extends boolean = boolean> extends StaticRef<'bytes'> {
  readonly [byteReadonly]: ReadonlyBytes;
}

export interface InboxRef extends StaticRef<'inbox'> {
  readonly [byteReadonly]: true;
}

export type ReadableBytesRef = BytesRef | InboxRef;
export type WritableBytesRef = BytesRef<false>;
export type ResourceRef = StateRef | ArrayRef | ReadableBytesRef;

export interface FunctionSignature<
  P extends readonly ScalarType[],
  R extends readonly ScalarType[],
> {
  readonly params: P;
  readonly results: R;
}

export type FunctionBody<P extends readonly ScalarType[], R extends readonly ScalarType[]> = (
  b: FunctionBuilder<R>,
  params: Values<P>,
) => undefined;

export interface FunctionRef<
  P extends readonly ScalarType[] = readonly ScalarType[],
  R extends readonly ScalarType[] = readonly ScalarType[],
> extends StaticRef<'function'> {
  readonly [signature]: FunctionSignature<P, R>;
  body(callback: FunctionBody<P, R>): undefined;
}

export interface EntryRef<
  P extends readonly ScalarType[] = readonly ScalarType[],
> extends StaticRef<'entry'> {
  readonly [signature]: FunctionSignature<P, readonly []>;
  body(callback: FunctionBody<P, readonly []>): undefined;
}

export interface LifecycleRef<
  P extends readonly ScalarType[] = readonly ScalarType[],
> extends StaticRef<'lifecycle'> {
  readonly [signature]: FunctionSignature<P, readonly []>;
  body(callback: FunctionBody<P, readonly []>): undefined;
}

export interface BlockRef<
  P extends readonly ScalarType[] = readonly ScalarType[],
> extends StaticRef<'block'> {
  readonly [signature]: FunctionSignature<P, readonly []>;
}

export interface Edge<P extends readonly ScalarType[]> {
  readonly target: BlockRef<P>;
  readonly args: Values<NoInfer<P>>;
}

export type Wider<T extends IntegerType> = {
  u8: 'u16' | 'i16' | 'u32' | 'i32';
  i8: 'u16' | 'i16' | 'u32' | 'i32';
  u16: 'u32' | 'i32';
  i16: 'u32' | 'i32';
  u32: never;
  i32: never;
}[T];

export type Narrower<T extends IntegerType> = {
  u8: never;
  i8: never;
  u16: 'u8' | 'i8';
  i16: 'u8' | 'i8';
  u32: 'u8' | 'i8' | 'u16' | 'i16';
  i32: 'u8' | 'i8' | 'u16' | 'i16';
}[T];

export type OppositeSign<T extends IntegerType> = {
  u8: 'i8';
  i8: 'u8';
  u16: 'i16';
  i16: 'u16';
  u32: 'i32';
  i32: 'u32';
}[T];

export type BitcastSource = 'f32' | 'u32' | 'i32';
export type BitcastTarget<T extends BitcastSource> = T extends 'f32' ? 'u32' | 'i32' : 'f32';

interface IntegerBinary {
  <T extends IntegerType>(left: Value<T>, right: Value<NoInfer<T>>): Value<T>;
}

interface IntegerShift {
  <T extends IntegerType>(value: Value<T>, count: Value<'u32'>): Value<T>;
}

interface FloatBinary {
  <T extends FloatType>(left: Value<T>, right: Value<NoInfer<T>>): Value<T>;
}

export interface BooleanOperations {
  not(value: Value<'bool'>): Value<'bool'>;
  and(left: Value<'bool'>, right: Value<'bool'>): Value<'bool'>;
  or(left: Value<'bool'>, right: Value<'bool'>): Value<'bool'>;
  xor(left: Value<'bool'>, right: Value<'bool'>): Value<'bool'>;
}

export interface IntegerOperations {
  readonly add: IntegerBinary;
  readonly sub: IntegerBinary;
  readonly mul: IntegerBinary;
  readonly div: IntegerBinary;
  readonly rem: IntegerBinary;
  readonly and: IntegerBinary;
  readonly or: IntegerBinary;
  readonly xor: IntegerBinary;
  not<T extends IntegerType>(value: Value<T>): Value<T>;
  readonly shl: IntegerShift;
  readonly lshr: IntegerShift;
  ashr<T extends SignedIntegerType>(value: Value<T>, count: Value<'u32'>): Value<T>;
  cmp<T extends IntegerType>(
    predicate: Predicate,
    left: Value<T>,
    right: Value<NoInfer<T>>,
  ): Value<'bool'>;
  zext<S extends IntegerType, D extends Wider<NoInfer<S>>>(target: D, value: Value<S>): Value<D>;
  sext<S extends SignedIntegerType, D extends Wider<NoInfer<S>>>(
    target: D,
    value: Value<S>,
  ): Value<D>;
  trunc<S extends IntegerType, D extends Narrower<NoInfer<S>>>(
    target: D,
    value: Value<S>,
  ): Value<D>;
  reinterpret<S extends IntegerType, D extends OppositeSign<NoInfer<S>>>(
    target: D,
    value: Value<S>,
  ): Value<D>;
}

export interface FloatOperations {
  readonly add: FloatBinary;
  readonly sub: FloatBinary;
  readonly mul: FloatBinary;
  readonly div: FloatBinary;
  fma<T extends FloatType>(a: Value<T>, b: Value<NoInfer<T>>, c: Value<NoInfer<T>>): Value<T>;
  cmp<T extends FloatType>(
    predicate: Predicate,
    left: Value<T>,
    right: Value<NoInfer<T>>,
  ): Value<'bool'>;
  isNaN<T extends FloatType>(value: Value<T>): Value<'bool'>;
  isFinite<T extends FloatType>(value: Value<T>): Value<'bool'>;
}

export interface ConversionOperations {
  intToFloat<S extends IntegerType, D extends FloatType>(target: D, value: Value<S>): Value<D>;
  floatToInt<S extends FloatType, D extends IntegerType>(target: D, value: Value<S>): Value<D>;
  float<S extends FloatType, D extends FloatType>(target: D, value: Value<S>): Value<D>;
}

export interface StateOperations {
  load<T extends ScalarType>(ref: StateRef<T>): Value<T>;
  store<T extends ScalarType>(ref: StateRef<T>, value: Value<NoInfer<T>>): undefined;
}

export interface ArrayOperations {
  load<T extends ScalarType>(ref: ArrayRef<T>, index: Value<'u32'>): Value<T>;
  store<T extends ScalarType>(
    ref: ArrayRef<T>,
    index: Value<'u32'>,
    value: Value<NoInfer<T>>,
  ): undefined;
}

export interface BytesOperations {
  load<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: ReadableBytesRef,
    offset: Value<'u32'>,
  ): Value<T>;
  store<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: WritableBytesRef,
    offset: Value<'u32'>,
    value: Value<NoInfer<T>>,
  ): undefined;
  copy(
    destination: WritableBytesRef,
    destinationOffset: Value<'u32'>,
    source: ReadableBytesRef,
    sourceOffset: Value<'u32'>,
    length: Value<'u32'>,
  ): undefined;
}

export type DomainOperandType =
  | { readonly kind: 'value'; readonly type: ScalarType }
  | { readonly kind: 'static'; readonly category: string }
  | { readonly kind: 'literal' };

export type DomainOperandValue<O extends DomainOperandType> = O extends {
  readonly kind: 'value';
  readonly type: infer T extends ScalarType;
}
  ? Value<T>
  : O extends { readonly kind: 'static'; readonly category: infer C extends string }
    ? StaticRef<C>
    : O extends { readonly kind: 'literal' }
      ? boolean | number | string
      : never;

export type DomainOperandValues<O extends readonly DomainOperandType[]> = {
  readonly [I in keyof O]: DomainOperandValue<O[I]>;
};

export interface DomainInstructionDefinition<
  O extends readonly DomainOperandType[] = readonly DomainOperandType[],
  R extends readonly ScalarType[] = readonly ScalarType[],
> {
  readonly operands: O;
  readonly results: R;
}

export interface DomainInstruction<
  O extends readonly DomainOperandType[] = readonly DomainOperandType[],
  R extends readonly ScalarType[] = readonly ScalarType[],
> extends StaticRef<'instruction'> {
  readonly name: string;
  readonly operands: O;
  readonly results: R;
}

export interface DeclaredInstruction {
  readonly name: string;
  readonly operands: readonly DomainOperandType[];
  readonly results: readonly ScalarType[];
}

/**
 * Explicit instruction extension surface. Domain modules declare static
 * handles and instructions here; the core never imports a domain module and
 * never turns a host JavaScript callback into an instruction.
 */
export interface IRDeclarations {
  state<T extends ScalarType>(name: string, type: T, initial: JSScalar<NoInfer<T>>): StateRef<T>;
  array<T extends ScalarType>(
    name: string,
    type: T,
    initial: readonly JSScalar<NoInfer<T>>[],
  ): ArrayRef<T>;
  bytes<const ReadonlyBytes extends boolean>(
    name: string,
    initial: Uint8Array,
    options: BytesOptions<ReadonlyBytes>,
  ): BytesRef<ReadonlyBytes>;
  inbox(name: string, capacity: number): InboxRef;
  func<const P extends readonly ScalarType[], const R extends readonly ScalarType[]>(
    name: string,
    signature: FunctionSignature<P, R>,
  ): FunctionRef<P, R>;
  entry<const P extends readonly ScalarType[]>(name: string, params: P): EntryRef<P>;
  lifecycle<const P extends readonly ScalarType[]>(name: string, params: P): LifecycleRef<P>;
}

export interface BytesOptions<ReadonlyBytes extends boolean> {
  readonly readonly: ReadonlyBytes;
  readonly unitBytes?: number;
}

export interface FunctionBuilder<R extends readonly ScalarType[] = readonly []> {
  const<T extends ScalarType>(type: T, literal: JSScalar<NoInfer<T>>): Value<T>;
  bits<T extends FloatType>(type: T, bits: HexBits): Value<T>;
  readonly bool: BooleanOperations;
  readonly int: IntegerOperations;
  readonly float: FloatOperations;
  readonly convert: ConversionOperations;
  bitcast<S extends BitcastSource, D extends BitcastTarget<NoInfer<S>>>(
    target: D,
    value: Value<S>,
  ): Value<D>;
  select<T extends ScalarType>(
    condition: Value<'bool'>,
    yes: Value<T>,
    no: Value<NoInfer<T>>,
  ): Value<T>;
  readonly state: StateOperations;
  readonly array: ArrayOperations;
  readonly bytes: BytesOperations;
  call<P extends readonly ScalarType[], Results extends readonly ScalarType[]>(
    target: FunctionRef<P, Results>,
    args: Values<NoInfer<P>>,
  ): Values<Results>;
  block<const P extends readonly ScalarType[]>(types: P): BlockRef<P>;
  at<P extends readonly ScalarType[]>(
    block: BlockRef<P>,
    callback: (b: FunctionBuilder<R>, params: Values<P>) => undefined,
  ): undefined;
  invoke<const O extends readonly DomainOperandType[], const R extends readonly ScalarType[]>(
    instruction: DomainInstruction<O, R>,
    operands: DomainOperandValues<NoInfer<O>>,
  ): Values<R>;
  return(results: Values<R>): undefined;
  jump<P extends readonly ScalarType[]>(block: BlockRef<P>, args: Values<NoInfer<P>>): undefined;
  branch<Yes extends readonly ScalarType[], No extends readonly ScalarType[]>(
    condition: Value<'bool'>,
    yes: Edge<Yes>,
    no: Edge<No>,
  ): undefined;
  trap(code: string): undefined;
}

/**
 * Type boundary for Provider-generated functions. Provider generation,
 * checkpoints, and dispatch belong to a later task; this interface only keeps
 * nested block callbacks on the specialized builder family.
 */
export interface GeneratedFunctionBuilder<
  R extends readonly ScalarType[] = readonly [],
> extends FunctionBuilder<R> {
  at<P extends readonly ScalarType[]>(
    block: BlockRef<P>,
    callback: (b: GeneratedFunctionBuilder<R>, params: Values<P>) => undefined,
  ): undefined;
}

export type FunctionCategory = 'function' | 'entry' | 'lifecycle';
export type MemoryKind = 'state' | 'array' | 'bytes' | 'inbox';

export type MemoryLayout =
  | {
      readonly kind: 'scalar';
      readonly scalarType: ScalarType;
      readonly length: number;
    }
  | {
      readonly kind: 'bytes';
      readonly length: number;
      readonly unitBytes: number;
    };

export interface MemoryDefinition {
  readonly name: string;
  readonly kind: MemoryKind;
  readonly layout: MemoryLayout;
  readonly writable: boolean;
  readonly initial: readonly (boolean | number)[];
  readonly ref: StateRef | ArrayRef | BytesRef | InboxRef;
}

export interface DomainDeclaration {
  readonly kind: string;
  readonly name: string;
  readonly ref: StaticRef;
}

export type InstructionOperand =
  | { readonly kind: 'ssa'; readonly value: Value }
  | { readonly kind: 'static'; readonly ref: StaticRef }
  | { readonly kind: 'literal'; readonly value: boolean | number | string };

export interface InstructionNode {
  readonly op: string;
  readonly operands: readonly InstructionOperand[];
  readonly results: readonly Value[];
}

export interface EdgeDefinition {
  readonly target: BlockDefinition;
  readonly args: readonly Value[];
}

export type Terminator =
  | {
      readonly kind: 'jump';
      readonly target: BlockDefinition;
      readonly args: readonly Value[];
    }
  | {
      readonly kind: 'branch';
      readonly condition: Value<'bool'>;
      readonly yes: EdgeDefinition;
      readonly no: EdgeDefinition;
    }
  | { readonly kind: 'return'; readonly values: readonly Value[] }
  | { readonly kind: 'trap'; readonly code: string };

export interface BlockDefinition {
  readonly id: number;
  readonly params: readonly Value[];
  readonly instructions: readonly InstructionNode[];
  readonly terminator: Terminator | undefined;
  readonly defined: boolean;
}

export interface FunctionBodyDefinition {
  readonly entry: BlockDefinition;
  readonly blocks: readonly BlockDefinition[];
}

export interface FunctionDefinition {
  readonly ref: FunctionRef | EntryRef | LifecycleRef;
  readonly name: string;
  readonly category: FunctionCategory;
  readonly params: readonly ScalarType[];
  readonly results: readonly ScalarType[];
  readonly body: FunctionBodyDefinition | undefined;
}

export interface IRModule extends IRDeclarations {
  readonly memories: readonly MemoryDefinition[];
  readonly functions: readonly FunctionDefinition[];
  readonly domainDeclarations: readonly DomainDeclaration[];
  readonly instructions: readonly DeclaredInstruction[];
  domainDeclaration<Kind extends string>(kind: Kind, name: string): StaticRef<Kind>;
  domainInstruction<
    const O extends readonly DomainOperandType[],
    const R extends readonly ScalarType[],
  >(
    name: string,
    definition: DomainInstructionDefinition<O, R>,
  ): DomainInstruction<O, R>;
}
