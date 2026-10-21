import { fail } from './errors';
import type {
  BlockRef,
  DomainInstruction,
  FunctionRef,
  ScalarType,
  StateRef,
  StaticRef,
  Value,
  ArrayRef,
  BytesRef,
  InboxRef,
} from './types';
import {
  byteReadonly,
  scalarType,
  signature,
  refKind,
  valueKind,
  FLOAT_TYPES,
  INTEGER_TYPES,
  NUMERIC_TYPES,
  SCALAR_TYPES,
  SIGNED_INTEGER_TYPES,
} from './types';
import type {
  BlockState,
  BuilderState,
  DomainDeclarationState,
  DomainInstructionState,
  FunctionDeclarationState,
  MemoryState,
  ModuleState,
} from './state';

interface ValueMetadata {
  readonly owner: BuilderState;
  readonly id: number;
  readonly type: ScalarType;
}

interface BlockMetadata {
  readonly owner: BuilderState;
  readonly block: BlockState;
}

const valueMetadata = new WeakMap<object, ValueMetadata>();
const blockMetadata = new WeakMap<object, BlockMetadata>();
const memoryMetadata = new WeakMap<object, MemoryState>();
const functionMetadata = new WeakMap<object, FunctionDeclarationState>();
const staticMetadata = new WeakMap<object, DomainDeclarationState>();
const instructionMetadata = new WeakMap<object, DomainInstructionState>();

export function createValue<T extends ScalarType>(
  owner: BuilderState,
  type: T,
  id: number,
): Value<T> {
  const value = { [valueKind]: 'ssa-value', type } as Value<T>;
  valueMetadata.set(value, { owner, id, type });
  return value;
}

export function getValueMetadata(value: Value): ValueMetadata | undefined {
  return valueMetadata.get(value);
}

export function createStateRef<T extends ScalarType>(memory: MemoryState, type: T): StateRef<T> {
  const ref = { [refKind]: 'state', [scalarType]: type } as StateRef<T>;
  memoryMetadata.set(ref, memory);
  return ref;
}

export function createArrayRef<T extends ScalarType>(memory: MemoryState, type: T): ArrayRef<T> {
  const ref = { [refKind]: 'array', [scalarType]: type } as ArrayRef<T>;
  memoryMetadata.set(ref, memory);
  return ref;
}

export function createBytesRef<ReadonlyBytes extends boolean>(
  memory: MemoryState,
  readonly: ReadonlyBytes,
): BytesRef<ReadonlyBytes> {
  const ref = { [refKind]: 'bytes', [byteReadonly]: readonly } as BytesRef<ReadonlyBytes>;
  memoryMetadata.set(ref, memory);
  return ref;
}

export function createInboxRef(memory: MemoryState): InboxRef {
  const ref = { [refKind]: 'inbox', [byteReadonly]: true } as InboxRef;
  memoryMetadata.set(ref, memory);
  return ref;
}

export function createFunctionRef(
  declaration: FunctionDeclarationState,
  defineBody: (declaration: FunctionDeclarationState, callback: unknown) => void,
): FunctionRef {
  const ref = {
    [refKind]: declaration.category,
    [signature]: { params: declaration.params, results: declaration.results },
    body: (callback: unknown) => {
      defineBody(declaration, callback);
      return undefined;
    },
  } as unknown as FunctionRef;
  functionMetadata.set(ref, declaration);
  return ref;
}

export function createBlockRef(block: BlockState): BlockRef {
  const ref = {
    [refKind]: 'block',
    [signature]: { params: block.paramTypes, results: [] },
  } as unknown as BlockRef;
  blockMetadata.set(ref, { owner: block.owner, block });
  return ref;
}

export function createDomainStaticRef<Kind extends string>(
  declaration: DomainDeclarationState,
): StaticRef<Kind> {
  const ref = { [refKind]: declaration.kind } as StaticRef<Kind>;
  staticMetadata.set(ref, declaration);
  return ref;
}

export function createDomainInstructionRef(instruction: DomainInstructionState): DomainInstruction {
  const ref = {
    [refKind]: 'instruction',
    name: instruction.name,
    operands: instruction.definition.operands,
    results: instruction.definition.results,
  } as unknown as DomainInstruction;
  instructionMetadata.set(ref, instruction);
  return ref;
}

export function getBlockMetadata(ref: BlockRef): BlockMetadata | undefined {
  return blockMetadata.get(ref);
}

export function getMemoryMetadata(ref: object): MemoryState | undefined {
  return memoryMetadata.get(ref);
}

export function getFunctionMetadata(ref: object): FunctionDeclarationState | undefined {
  return functionMetadata.get(ref);
}

export function getDomainStaticMetadata(ref: object): DomainDeclarationState | undefined {
  return staticMetadata.get(ref);
}

export function getInstructionMetadata(ref: object): DomainInstructionState | undefined {
  return instructionMetadata.get(ref);
}

export function getRefModule(ref: StaticRef): ModuleState | undefined {
  return (
    memoryMetadata.get(ref)?.module ??
    functionMetadata.get(ref)?.module ??
    staticMetadata.get(ref)?.module ??
    instructionMetadata.get(ref)?.module
  );
}

export function isScalarType(value: unknown): value is ScalarType {
  return typeof value === 'string' && (SCALAR_TYPES as readonly string[]).includes(value);
}

export function isIntegerType(value: unknown): boolean {
  return typeof value === 'string' && (INTEGER_TYPES as readonly string[]).includes(value);
}

export function isSignedIntegerType(value: unknown): boolean {
  return typeof value === 'string' && (SIGNED_INTEGER_TYPES as readonly string[]).includes(value);
}

export function isFloatType(value: unknown): boolean {
  return typeof value === 'string' && (FLOAT_TYPES as readonly string[]).includes(value);
}

export function isNumericType(value: unknown): boolean {
  return typeof value === 'string' && (NUMERIC_TYPES as readonly string[]).includes(value);
}

export function assertScalarType(value: unknown, label: string): asserts value is ScalarType {
  if (!isScalarType(value)) {
    fail(`${label} must be a scalar type, received ${String(value)}`);
  }
}

export function assertScalarTypeList(values: unknown, label: string): readonly ScalarType[] {
  if (!Array.isArray(values)) {
    fail(`${label} must be an array of scalar types`);
  }
  const result = Array.from(values, (value, index) => {
    assertScalarType(value, `${label}[${index}]`);
    return value;
  });
  return result;
}

export function assertValue(
  value: Value,
  owner: BuilderState,
  expectedType: ScalarType,
  label: string,
): void {
  if (typeof value !== 'object' || value === null) {
    fail(`${label} must be an SSA value`);
  }
  const metadata = valueMetadata.get(value);
  if (metadata === undefined) {
    fail(`${label} is not an SSA value created by this builder`);
  }
  if (metadata.owner !== owner) {
    fail(`${label} belongs to another function`);
  }
  if (metadata.type !== expectedType || value.type !== expectedType) {
    fail(`${label} must have type ${expectedType}, received ${String(value.type)}`);
  }
}

export function assertValueList(
  values: readonly Value[],
  owner: BuilderState,
  expectedTypes: readonly ScalarType[],
  label: string,
): void {
  if (!Array.isArray(values)) {
    fail(`${label} must be an array of SSA values`);
  }
  if (values.length !== expectedTypes.length) {
    fail(`${label} must contain ${expectedTypes.length} value(s), received ${values.length}`);
  }
  for (let index = 0; index < values.length; index += 1) {
    const expected = expectedTypes[index];
    if (expected === undefined) {
      fail(`${label}[${index}] has no corresponding type`);
    }
    assertValue(values[index] as Value, owner, expected, `${label}[${index}]`);
  }
}

export function assertStaticRef(
  ref: StaticRef,
  module: ModuleState,
  kind: string,
  label: string,
): void {
  if (typeof ref !== 'object' || ref === null) {
    fail(`${label} must be a static reference`);
  }
  if (ref[refKind] !== kind) {
    fail(`${label} must be a ${kind} reference, received ${String(ref[refKind])}`);
  }
  if (getRefModule(ref) !== module) {
    fail(`${label} belongs to another module`);
  }
}

export function requireBlock(ref: BlockRef, owner: BuilderState, label: string): BlockState {
  const metadata = getBlockMetadata(ref);
  if (metadata === undefined) {
    fail(`${label} is not a block reference`);
  }
  if (metadata.owner !== owner) {
    fail(`${label} belongs to another function`);
  }
  return metadata.block;
}

export function assertEdgeLayout(
  block: BlockState,
  args: readonly Value[],
  owner: BuilderState,
  label: string,
): void {
  assertValueList(args, owner, block.paramTypes, label);
}

export function normalizeScalarLiteral<T extends ScalarType>(
  type: T,
  literal: unknown,
  label = `const<${type}>`,
): boolean | number {
  if (type === 'bool') {
    if (typeof literal !== 'boolean') {
      fail(`${label} requires a boolean literal`);
    }
    return literal;
  }
  if (typeof literal !== 'number') {
    fail(`${label} requires a number literal`);
  }
  if (isIntegerType(type)) {
    if (!Number.isInteger(literal)) {
      fail(`${label} requires an integer literal, received ${String(literal)}`);
    }
    const range = integerRange(type as (typeof INTEGER_TYPES)[number]);
    if (literal < range.min || literal > range.max) {
      fail(`${label} literal ${literal} is outside [${range.min}, ${range.max}]`);
    }
    return literal;
  }
  return type === 'f32' ? Math.fround(literal) : literal;
}

export function integerRange(type: (typeof INTEGER_TYPES)[number]): {
  readonly min: number;
  readonly max: number;
} {
  switch (type) {
    case 'u8':
      return { min: 0, max: 0xff };
    case 'u16':
      return { min: 0, max: 0xffff };
    case 'u32':
      return { min: 0, max: 0xffffffff };
    case 'i8':
      return { min: -0x80, max: 0x7f };
    case 'i16':
      return { min: -0x8000, max: 0x7fff };
    case 'i32':
      return { min: -0x80000000, max: 0x7fffffff };
  }
}

export function assertHexBits(type: 'f32' | 'f64', bits: unknown): asserts bits is string {
  if (typeof bits !== 'string') {
    fail(`const.bits<${type}> requires a hexadecimal string`);
  }
  const digits = type === 'f32' ? 8 : 16;
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${digits}}$`);
  if (!pattern.test(bits)) {
    fail(`const.bits<${type}> requires exactly ${digits} hexadecimal digits`);
  }
}

export function assertName(name: unknown, label: string): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    fail(`${label} name must be a non-empty string`);
  }
}

export function assertCapacity(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

export function assertSyncCallbackResult(result: unknown, label: string): void {
  if (result !== undefined) {
    fail(`${label} must be synchronous and return undefined`);
  }
}
