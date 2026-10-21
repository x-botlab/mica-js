import { getMemoryMetadata, integerRange, isNumericType, isScalarType } from './runtime';
import type {
  ArrayRef,
  Endian,
  FloatBits,
  FloatType,
  HexBits,
  IntegerType,
  IRModule,
  MemoryDefinition,
  NumericType,
  ReadableBytesRef,
  RuntimeScalar,
  ScalarType,
  StateRef,
  WritableBytesRef,
} from './types';
import { byteReadonly, refKind, scalarType } from './types';

export type IRStorageErrorCode =
  | 'invalid-resource'
  | 'invalid-value'
  | 'invalid-argument'
  | 'out-of-bounds'
  | 'readonly-resource'
  | 'allocation-failure';

export class IRStorageError extends Error {
  override readonly name = 'IRStorageError';

  constructor(
    readonly code: IRStorageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type StorageValue<T extends ScalarType> = T extends 'bool'
  ? boolean
  : T extends FloatType
    ? FloatBits
    : number;

/**
 * Per-instance storage for declared state, arrays, byte regions, and inboxes.
 * The buffers are private; callers can only use the checked accessors.
 */
export interface IRStorage {
  loadState<T extends ScalarType>(ref: StateRef<T>): StorageValue<T>;
  storeState<T extends ScalarType>(ref: StateRef<T>, value: RuntimeScalar): void;

  loadArray<T extends ScalarType>(ref: ArrayRef<T>, index: number): StorageValue<T>;
  storeArray<T extends ScalarType>(ref: ArrayRef<T>, index: number, value: RuntimeScalar): void;

  loadBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: ReadableBytesRef,
    offset: number,
  ): StorageValue<T>;
  storeBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: WritableBytesRef,
    offset: number,
    value: RuntimeScalar,
  ): void;

  copy(
    destination: WritableBytesRef,
    destinationOffset: number,
    source: ReadableBytesRef,
    sourceOffset: number,
    length: number,
  ): void;
}

interface BaseRecord {
  readonly definition: MemoryDefinition;
  readonly ref: object;
  readonly kind: MemoryDefinition['kind'];
  readonly writable: boolean;
  readonly bytes: Uint8Array;
}

interface ScalarRecord extends BaseRecord {
  readonly scalarType: ScalarType;
  readonly length: number;
  readonly width: number;
}

interface ByteRecord extends BaseRecord {
  readonly length: number;
}

type MemoryRecord = ScalarRecord | ByteRecord;

const CANONICAL_NAN: Readonly<Record<FloatType, bigint>> = {
  f32: 0x7fc00000n,
  f64: 0x7ff8000000000000n,
};

export function createIRStorage(module: IRModule): IRStorage {
  if (!isRecord(module) || !Array.isArray(module.memories)) {
    throw new IRStorageError('invalid-resource', 'createIRStorage requires an IR module');
  }
  const records = new Map<object, MemoryRecord>();
  for (const definition of module.memories) {
    const record = createRecord(definition);
    if (records.has(record.ref)) {
      throw new IRStorageError('invalid-resource', 'Duplicate memory reference in module');
    }
    records.set(record.ref, record);
  }
  return new Storage(records);
}

class Storage implements IRStorage {
  readonly #records: ReadonlyMap<object, MemoryRecord>;

  constructor(records: ReadonlyMap<object, MemoryRecord>) {
    this.#records = records;
    Object.freeze(this);
  }

  loadState<T extends ScalarType>(ref: StateRef<T>): StorageValue<T> {
    const record = this.#scalar(ref, 'state', 'state.load resource');
    return decodeScalar(
      record.scalarType,
      readBits(record.bytes, 0, record.width, 'little'),
    ) as StorageValue<T>;
  }

  storeState<T extends ScalarType>(ref: StateRef<T>, value: RuntimeScalar): void {
    const record = this.#scalar(ref, 'state', 'state.store resource', true);
    writeScalar(record, 0, value);
  }

  loadArray<T extends ScalarType>(ref: ArrayRef<T>, index: number): StorageValue<T> {
    const record = this.#scalar(ref, 'array', 'array.load resource');
    const offset = scalarOffset(record, index, 'array.load index');
    return decodeScalar(
      record.scalarType,
      readBits(record.bytes, offset, record.width, 'little'),
    ) as StorageValue<T>;
  }

  storeArray<T extends ScalarType>(ref: ArrayRef<T>, index: number, value: RuntimeScalar): void {
    const record = this.#scalar(ref, 'array', 'array.store resource', true);
    const offset = scalarOffset(record, index, 'array.store index');
    writeScalar(record, offset, value);
  }

  loadBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: ReadableBytesRef,
    offset: number,
  ): StorageValue<T> {
    const record = this.#byte(ref, false, 'bytes.load resource');
    const width = numericWidth(type, 'bytes.load type');
    assertEndian(endian, 'bytes.load endian');
    const start = byteOffset(record, offset, width, 'bytes.load offset');
    return decodeScalar(type, readBits(record.bytes, start, width, endian)) as StorageValue<T>;
  }

  storeBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: WritableBytesRef,
    offset: number,
    value: RuntimeScalar,
  ): void {
    const record = this.#byte(ref, true, 'bytes.store resource');
    const width = numericWidth(type, 'bytes.store type');
    assertEndian(endian, 'bytes.store endian');
    const start = byteOffset(record, offset, width, 'bytes.store offset');
    const bits = encodeScalar(type, value);
    writeBits(record.bytes, start, width, endian, bits);
  }

  copy(
    destination: WritableBytesRef,
    destinationOffset: number,
    source: ReadableBytesRef,
    sourceOffset: number,
    length: number,
  ): void {
    const target = this.#byte(destination, true, 'bytes.copy destination');
    const origin = this.#byte(source, false, 'bytes.copy source');
    const count = unsigned32(length, 'bytes.copy length');
    const targetStart = byteOffset(
      target,
      destinationOffset,
      count,
      'bytes.copy destinationOffset',
    );
    const sourceStart = byteOffset(origin, sourceOffset, count, 'bytes.copy sourceOffset');
    if (count === 0) {
      return;
    }
    let snapshot: Uint8Array;
    try {
      snapshot = origin.bytes.slice(sourceStart, sourceStart + count);
    } catch {
      throw new IRStorageError('allocation-failure', 'bytes.copy could not snapshot its source');
    }
    target.bytes.set(snapshot, targetStart);
  }

  #scalar(ref: object, kind: 'state' | 'array', label: string, write = false): ScalarRecord {
    const record = this.#record(ref, label);
    if (record.kind !== kind || !('scalarType' in record)) {
      throw new IRStorageError('invalid-resource', `${label} must be a ${kind} reference`);
    }
    if (write && !record.writable) {
      throw new IRStorageError('readonly-resource', `${label} is not writable`);
    }
    return record;
  }

  #byte(ref: object, write: boolean, label: string): ByteRecord {
    const record = this.#record(ref, label);
    if (record.kind !== 'bytes' && record.kind !== 'inbox') {
      throw new IRStorageError('invalid-resource', `${label} must be a byte resource`);
    }
    if (write && (record.kind !== 'bytes' || !record.writable)) {
      throw new IRStorageError('readonly-resource', `${label} is not writable`);
    }
    return record;
  }

  #record(ref: object, label: string): MemoryRecord {
    if (!isRecord(ref)) {
      throw new IRStorageError('invalid-resource', `${label} must be a memory reference`);
    }
    const record = this.#records.get(ref);
    if (record === undefined) {
      throw new IRStorageError('invalid-resource', `${label} belongs to another module`);
    }
    const metadata = getMemoryMetadata(ref);
    if (metadata === undefined || metadata.definition !== record.definition) {
      throw new IRStorageError('invalid-resource', `${label} is not a declared memory reference`);
    }
    return record;
  }
}

function createRecord(definition: MemoryDefinition): MemoryRecord {
  if (!isRecord(definition) || !isRecord(definition.ref)) {
    throw new IRStorageError('invalid-resource', 'Invalid memory definition');
  }
  const kind = definition.kind;
  if (kind !== 'state' && kind !== 'array' && kind !== 'bytes' && kind !== 'inbox') {
    throw new IRStorageError('invalid-resource', 'Unknown memory kind');
  }
  if (definition.ref[refKind] !== kind || typeof definition.writable !== 'boolean') {
    throw new IRStorageError(
      'invalid-resource',
      `Memory "${definition.name}" has an invalid reference`,
    );
  }
  const layout = definition.layout;
  if (!isRecord(layout) || !Array.isArray(definition.initial)) {
    throw new IRStorageError(
      'invalid-resource',
      `Memory "${definition.name}" has an invalid layout`,
    );
  }

  if (layout.kind === 'scalar') {
    if (kind !== 'state' && kind !== 'array') {
      throw new IRStorageError(
        'invalid-resource',
        `Memory "${definition.name}" has an invalid layout`,
      );
    }
    const type = layout.scalarType;
    if (
      !isScalarType(type) ||
      (definition.ref as { readonly [scalarType]?: unknown })[scalarType] !== type
    ) {
      throw new IRStorageError(
        'invalid-resource',
        `Memory "${definition.name}" has an invalid scalar type`,
      );
    }
    const length = layout.length;
    if (!isCapacity(length) || (kind === 'state' && length !== 1)) {
      throw new IRStorageError(
        'invalid-resource',
        `Memory "${definition.name}" has an invalid length`,
      );
    }
    if (definition.initial.length !== length || !definition.writable) {
      throw new IRStorageError(
        'invalid-resource',
        `Memory "${definition.name}" has an invalid initializer`,
      );
    }
    const width = scalarWidth(type);
    const bytes = allocate(length, width, definition.name);
    const record: ScalarRecord = {
      definition,
      ref: definition.ref,
      kind,
      writable: definition.writable,
      bytes,
      scalarType: type,
      length,
      width,
    };
    definition.initial.forEach((value, index) => {
      writeBits(record.bytes, index * width, width, 'little', encodeScalar(type, value));
    });
    return record;
  }

  if (layout.kind === 'bytes') {
    if (kind !== 'bytes' && kind !== 'inbox') {
      throw new IRStorageError(
        'invalid-resource',
        `Memory "${definition.name}" has an invalid layout`,
      );
    }
    const length = layout.length;
    const unitBytes = layout.unitBytes;
    if (
      !isCapacity(length) ||
      !isCapacity(unitBytes) ||
      (length !== 0 && unitBytes === 0) ||
      (kind === 'inbox' && (definition.writable || unitBytes !== length)) ||
      definition.initial.length !== length ||
      (definition.ref as { readonly [byteReadonly]?: unknown })[byteReadonly] !==
        !definition.writable
    ) {
      throw new IRStorageError(
        'invalid-resource',
        `Memory "${definition.name}" has an invalid byte layout`,
      );
    }
    const bytes = allocate(length, 1, definition.name);
    definition.initial.forEach((value, index) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xff) {
        throw new IRStorageError(
          'invalid-value',
          `Memory "${definition.name}" has an invalid byte initializer`,
        );
      }
      if (kind === 'inbox' && value !== 0) {
        throw new IRStorageError('invalid-value', `Inbox "${definition.name}" must start zeroed`);
      }
      bytes[index] = value;
    });
    return {
      definition,
      ref: definition.ref,
      kind,
      writable: definition.writable,
      bytes,
      length,
    };
  }

  throw new IRStorageError('invalid-resource', `Memory "${definition.name}" has an invalid layout`);
}

function writeScalar(record: ScalarRecord, offset: number, value: RuntimeScalar): void {
  const bits = encodeScalar(record.scalarType, value);
  writeBits(record.bytes, offset, record.width, 'little', bits);
}

function scalarOffset(record: ScalarRecord, index: number, label: string): number {
  const position = unsigned32(index, label);
  if (position >= record.length) {
    throw new IRStorageError(
      'out-of-bounds',
      `${label} ${position} is outside [0, ${record.length})`,
    );
  }
  return position * record.width;
}

function byteOffset(record: ByteRecord, offset: number, width: number, label: string): number {
  const position = unsigned32(offset, label);
  if (position > record.length || width > record.length - position) {
    throw new IRStorageError(
      'out-of-bounds',
      `${label} ${position} exceeds capacity ${record.length}`,
    );
  }
  return position;
}

function unsigned32(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new IRStorageError('invalid-argument', `${label} must be a u32`);
  }
  return value;
}

function assertEndian(value: unknown, label: string): asserts value is Endian {
  if (value !== 'little' && value !== 'big') {
    throw new IRStorageError('invalid-argument', `${label} must be little or big`);
  }
}

function numericWidth(value: unknown, label: string): number {
  if (!isNumericType(value)) {
    throw new IRStorageError('invalid-argument', `${label} must be a numeric type`);
  }
  return scalarWidth(value as ScalarType);
}

function scalarWidth(type: ScalarType): number {
  if (type === 'bool' || type === 'u8' || type === 'i8') return 1;
  if (type === 'u16' || type === 'i16') return 2;
  if (type === 'u32' || type === 'i32' || type === 'f32') return 4;
  return 8;
}

function encodeScalar(type: ScalarType, value: RuntimeScalar): bigint {
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new IRStorageError('invalid-value', 'bool storage requires a boolean value');
    }
    return value ? 1n : 0n;
  }
  if (type === 'f32' || type === 'f64') {
    return typeof value === 'number' ? numberBits(type, value) : floatBits(type, value);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new IRStorageError('invalid-value', `${type} storage requires an integer value`);
  }
  const range = integerRange(type as IntegerType);
  if (value < range.min || value > range.max) {
    throw new IRStorageError('invalid-value', `${value} is outside the ${type} range`);
  }
  return BigInt.asUintN(scalarWidth(type) * 8, BigInt(value));
}

function decodeScalar(type: ScalarType, bits: bigint): RuntimeScalar {
  if (type === 'bool') {
    return bits !== 0n;
  }
  if (type === 'f32' || type === 'f64') {
    return packFloatBits(type, bits);
  }
  const width = scalarWidth(type) * 8;
  if (type === 'i8' || type === 'i16' || type === 'i32') {
    return Number(BigInt.asIntN(width, bits));
  }
  return Number(bits);
}

function numberBits(type: FloatType, value: number): bigint {
  if (Number.isNaN(value)) {
    return CANONICAL_NAN[type];
  }
  const view = new DataView(new ArrayBuffer(8));
  if (type === 'f32') {
    view.setFloat32(0, value, false);
    return BigInt(view.getUint32(0, false));
  }
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

function floatBits(type: FloatType, value: RuntimeScalar): bigint {
  if (!isRecord(value) || value.type !== type || typeof value.bits !== 'string') {
    throw new IRStorageError(
      'invalid-value',
      `${type} storage requires a matching FloatBits value`,
    );
  }
  const digits = type === 'f32' ? 8 : 16;
  if (!new RegExp(`^0x[0-9a-fA-F]{${digits}}$`).test(value.bits)) {
    throw new IRStorageError('invalid-value', `${type} FloatBits has an invalid bit pattern`);
  }
  return BigInt(value.bits);
}

function packFloatBits(type: FloatType, bits: bigint): FloatBits {
  const digits = type === 'f32' ? 8 : 16;
  return Object.freeze({
    type,
    bits: `0x${bits.toString(16).padStart(digits, '0')}` as HexBits,
  });
}

function readBits(bytes: Uint8Array, offset: number, width: number, endian: Endian): bigint {
  let value = 0n;
  for (let index = 0; index < width; index += 1) {
    const shift = endian === 'little' ? index : width - 1 - index;
    value |= BigInt(bytes[offset + index] ?? 0) << BigInt(shift * 8);
  }
  return value;
}

function writeBits(
  bytes: Uint8Array,
  offset: number,
  width: number,
  endian: Endian,
  value: bigint,
): void {
  for (let index = 0; index < width; index += 1) {
    const shift = endian === 'little' ? index : width - 1 - index;
    bytes[offset + index] = Number((value >> BigInt(shift * 8)) & 0xffn);
  }
}

function allocate(length: number, width: number, name: string): Uint8Array {
  if (length > Math.floor(Number.MAX_SAFE_INTEGER / width)) {
    throw new IRStorageError('invalid-resource', `Memory "${name}" capacity is too large`);
  }
  try {
    return new Uint8Array(length * width);
  } catch {
    throw new IRStorageError('allocation-failure', `Memory "${name}" could not be allocated`);
  }
}

function isCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
