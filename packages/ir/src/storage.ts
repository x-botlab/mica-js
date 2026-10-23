import { getMemoryMetadata, integerRange, isNumericType, isScalarType } from './runtime';
import type {
  ArrayRef,
  BytesRef,
  Endian,
  FloatBits,
  FloatType,
  HexBits,
  InboxRef,
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
  | 'unauthorized-resource'
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

/**
 * Internal storage fast path for the JIT. It is deliberately not re-exported from `index.ts`:
 * every other module must keep using the checked public `IRStorage` surface.
 *
 * Invariants the JIT may rely on:
 * - **I1**: if `control.epoch` reads the same value twice, no dependency token could have gone
 *   from valid to invalid in between, because `validateDependencies` only observes
 *   `record.units` and every unit-map reassignment bumps the epoch.
 * - **I3**: an epoch bump is sufficient but not necessary for an invalidation. Lazy unit creation
 *   and rewrites that happen to preserve every token also bump it; over-reporting is safe.
 *   (I2 lives on `ProviderRuntime.cacheEpoch` in `provider.ts`.)
 */
export const storageInternals: unique symbol = Symbol('mica.ir.storageInternals');

/** Mutable control block shared by every record of one storage instance. */
export interface StorageControl {
  /** Incremented on every reassignment of any record's unit map; never decreases. */
  epoch: number;
  /** Nesting depth of `suspendStorageWrites`; writes are rejected while greater than zero. */
  suspended: number;
}

/** Scalar record view exposed to the JIT. */
export interface ScalarRecordInternals {
  readonly kind: 'state' | 'array';
  readonly scalarType: ScalarType;
  readonly length: number;
  readonly width: number;
  /** Backing bytes: `byteOffset === 0` and the buffer is owned by this record. */
  readonly bytes: Uint8Array;
  /**
   * Typed view over {@link bytes}, present only on little-endian hosts. `bool` uses
   * `Uint8Array`; f32/f64 use `Float32Array`/`Float64Array`.
   */
  readonly view:
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | Float32Array
    | Float64Array
    | undefined;
  /**
   * Raw word view for f32/f64 only: f32 has `length` words, f64 has `2 * length` words with the
   * low word first (little-endian). JIT stores must write canonical NaN bits through this view.
   */
  readonly raw: Uint32Array | undefined;
  /** True while the whole-resource unit is tracked; writes must then call `advanceScalar`. */
  readonly tracked: () => boolean;
}

/** Byte record view exposed to the JIT. */
export interface ByteRecordInternals {
  readonly kind: 'bytes' | 'inbox';
  readonly writable: boolean;
  readonly length: number;
  readonly unitBytes: number;
  readonly bytes: Uint8Array;
  /** DataView covering the whole record for endian-explicit byte access. */
  readonly data: DataView;
}

/**
 * Object behind `storage[storageInternals]`. JIT code may use these members directly:
 * scalar loads/stores go through `view`/`raw`, byte access through `data`, and the guarded write
 * sequence is `control.suspended` → backing write → `advanceScalar` when `tracked()` is true.
 */
export interface StorageInternals {
  readonly control: StorageControl;
  readonly littleEndianHost: boolean;
  /** Returns the record; invalid refs throw the same `IRStorageError` as the public methods. */
  scalar(
    ref: object,
    kind: 'state' | 'array',
    label: string,
    write?: boolean,
  ): ScalarRecordInternals;
  bytes(ref: object, write: boolean, label: string): ByteRecordInternals;
  /** Mirrors the tracked-store path: a no-op while the record is untracked. */
  advanceScalar(record: ScalarRecordInternals): void;
}

export type StorageValue<T extends ScalarType> = T extends 'bool'
  ? boolean
  : T extends FloatType
    ? FloatBits
    : number;

declare const resourceIdentity: unique symbol;
declare const versionUnitIdentity: unique symbol;
declare const resourceVersion: unique symbol;

export type IRResourceIdentity = Readonly<{ [resourceIdentity]: true }>;
export type IRVersionUnitIdentity = Readonly<{ [versionUnitIdentity]: true }>;
export type IRResourceVersion = Readonly<{ [resourceVersion]: true }>;

export interface IRResourceDependency {
  readonly resource: IRResourceIdentity;
  readonly unit: IRVersionUnitIdentity;
  readonly version: IRResourceVersion;
}

export interface IRVersionedBytes {
  readonly bytes: Uint8Array;
  readonly dependencies: readonly IRResourceDependency[];
}

/** Whole-resource value plus the version units it was read from (#60). */
export interface IRVersionedScalar<T extends ScalarType> {
  readonly value: StorageValue<T>;
  readonly dependencies: readonly IRResourceDependency[];
}

/**
 * Internal tracked-read surface used by provider generation. It is symbol-keyed on purpose:
 * the public `IRStorage` contract does not grow scalar dependency accessors.
 */
export const providerReadState: unique symbol = Symbol('mica.ir.provider-read-state');
export const providerReadArray: unique symbol = Symbol('mica.ir.provider-read-array');

export interface IRProviderTrackedReads {
  [providerReadState]<T extends ScalarType>(ref: StateRef<T>): IRVersionedScalar<T>;
  [providerReadArray]<T extends ScalarType>(ref: ArrayRef<T>, index: number): IRVersionedScalar<T>;
}

export interface IRStorageOptions {
  readonly updateResources?: readonly BytesRef[];
}

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
  updateBytes(
    destination: BytesRef,
    destinationOffset: number,
    source: ReadableBytesRef,
    sourceOffset: number,
    length: number,
  ): void;
  fillBytes(destination: BytesRef, offset: number, length: number, value: number): void;
  /** Host-only inbox admission; ordinary IR writes remain rejected. */
  writeInbox(ref: InboxRef, offset: number, bytes: Uint8Array): void;
  /** Host-only versioned update from captured bytes; content and units commit atomically. */
  updateBytesFromBytes(ref: BytesRef, offset: number, bytes: Uint8Array): void;
  readVersionedBytes(ref: ReadableBytesRef, offset: number, length: number): IRVersionedBytes;
  validateDependencies(dependencies: readonly IRResourceDependency[]): boolean;
}

interface BaseRecord<K extends MemoryDefinition['kind'] = MemoryDefinition['kind']> {
  readonly definition: MemoryDefinition;
  readonly ref: object;
  readonly kind: K;
  readonly writable: boolean;
  readonly bytes: Uint8Array;
  /** Owning storage's control block; shared by every record of one storage instance. */
  readonly control: StorageControl;
}

interface ScalarRecord extends BaseRecord<'state' | 'array'>, ScalarRecordInternals {
  readonly identity: IRResourceIdentity;
  units: ReadonlyMap<number, IRResourceDependency>;
  /** Bound by the owning storage so `advanceScalar` can mint tokens and bump the epoch. */
  advance: () => void;
}

interface ByteRecord extends BaseRecord<'bytes' | 'inbox'>, ByteRecordInternals {
  readonly identity: IRResourceIdentity;
  units: ReadonlyMap<number, IRResourceDependency>;
}

type MemoryRecord = ScalarRecord | ByteRecord;

const CANONICAL_NAN: Readonly<Record<FloatType, bigint>> = {
  f32: 0x7fc00000n,
  f64: 0x7ff8000000000000n,
};

/** Storage instances whose mutating accessors are suspended for provider generation (#60). */
const suspendedWrites = new WeakMap<object, number>();
/** Control blocks by storage instance, so suspend/resume can mirror the nesting depth. */
const storageControls = new WeakMap<object, StorageControl>();

let littleEndianProbe: () => boolean = detectLittleEndianHost;

/**
 * @internal Replaces the host endianness probe. Tests use it to exercise the big-endian branch;
 * production code never calls it. Pass nothing to restore the real probe.
 */
export function setLittleEndianHostProbe(probe?: () => boolean): void {
  littleEndianProbe = probe ?? detectLittleEndianHost;
}

export function suspendStorageWrites(storage: IRStorage): void {
  const depth = (suspendedWrites.get(storage) ?? 0) + 1;
  suspendedWrites.set(storage, depth);
  const control = storageControls.get(storage);
  if (control !== undefined) control.suspended = depth;
}

export function resumeStorageWrites(storage: IRStorage): void {
  const depth = suspendedWrites.get(storage) ?? 0;
  const remaining = depth <= 1 ? 0 : depth - 1;
  if (remaining === 0) {
    suspendedWrites.delete(storage);
  } else {
    suspendedWrites.set(storage, remaining);
  }
  const control = storageControls.get(storage);
  if (control !== undefined) control.suspended = remaining;
}

function freezeDependency(identity: IRResourceIdentity): IRResourceDependency {
  return Object.freeze({
    resource: identity,
    unit: Object.freeze({}) as IRVersionUnitIdentity,
    version: Object.freeze({}) as IRResourceVersion,
  });
}

export function createIRStorage(module: IRModule, options?: IRStorageOptions): IRStorage {
  if (!isRecord(module) || !Array.isArray(module.memories)) {
    throw new IRStorageError('invalid-resource', 'createIRStorage requires an IR module');
  }
  const control: StorageControl = { epoch: 0, suspended: 0 };
  const littleEndianHost = littleEndianProbe();
  const records = new Map<object, MemoryRecord>();
  for (const definition of module.memories) {
    const record = createRecord(definition, control, littleEndianHost);
    if (records.has(record.ref)) {
      throw new IRStorageError('invalid-resource', 'Duplicate memory reference in module');
    }
    records.set(record.ref, record);
  }
  if (options !== undefined && !isRecord(options)) {
    throw new IRStorageError('invalid-argument', 'Expected storage options');
  }
  const updates = options?.updateResources === undefined ? [] : options.updateResources;
  if (!Array.isArray(updates)) {
    throw new IRStorageError('invalid-argument', 'updateResources must be an array');
  }
  const updateResources = new Set<object>();
  for (const ref of updates) {
    if (records.get(ref)?.kind !== 'bytes') {
      throw new IRStorageError(
        'invalid-resource',
        'Update authorization requires a listed byte resource',
      );
    }
    updateResources.add(ref);
  }
  return new Storage(records, updateResources, control, littleEndianHost);
}

class Storage implements IRStorage, IRProviderTrackedReads {
  readonly #records: ReadonlyMap<object, MemoryRecord>;
  readonly #updateResources: ReadonlySet<object>;
  readonly #dependencies = new WeakMap<object, { record: MemoryRecord; index: number }>();
  readonly #control: StorageControl;
  readonly #internals: StorageInternals;

  constructor(
    records: ReadonlyMap<object, MemoryRecord>,
    updateResources: ReadonlySet<object>,
    control: StorageControl,
    littleEndianHost: boolean,
  ) {
    this.#records = records;
    this.#updateResources = updateResources;
    this.#control = control;
    for (const record of records.values()) {
      if ('scalarType' in record) {
        // The closure keeps the dependency registry and epoch private to this storage.
        record.advance = () => this.#advanceScalar(record);
      }
    }
    this.#internals = Object.freeze({
      control,
      littleEndianHost,
      scalar: (ref: object, kind: 'state' | 'array', label: string, write = false) =>
        this.#scalar(ref, kind, label, write),
      bytes: (ref: object, write: boolean, label: string) => this.#byte(ref, write, label),
      advanceScalar,
    });
    storageControls.set(this, control);
    Object.freeze(this);
  }

  /** Internal fast path for the JIT; see the invariants documented on {@link storageInternals}. */
  get [storageInternals](): StorageInternals {
    return this.#internals;
  }

  loadState<T extends ScalarType>(ref: StateRef<T>): StorageValue<T> {
    const record = this.#scalar(ref, 'state', 'state.load resource');
    return decodeScalar(
      record.scalarType,
      readBits(record.bytes, 0, record.width, 'little'),
    ) as StorageValue<T>;
  }

  storeState<T extends ScalarType>(ref: StateRef<T>, value: RuntimeScalar): void {
    this.#assertWritable();
    const record = this.#scalar(ref, 'state', 'state.store resource', true);
    writeScalar(record, 0, value);
    this.#advanceScalar(record);
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
    this.#assertWritable();
    const record = this.#scalar(ref, 'array', 'array.store resource', true);
    const offset = scalarOffset(record, index, 'array.store index');
    writeScalar(record, offset, value);
    this.#advanceScalar(record);
  }

  [providerReadState]<T extends ScalarType>(ref: StateRef<T>): IRVersionedScalar<T> {
    const record = this.#scalar(ref, 'state', 'readState resource');
    const value = decodeScalar(
      record.scalarType,
      readBits(record.bytes, 0, record.width, 'little'),
    ) as StorageValue<T>;
    return Object.freeze({ value, dependencies: Object.freeze([this.#scalarUnit(record)]) });
  }

  [providerReadArray]<T extends ScalarType>(ref: ArrayRef<T>, index: number): IRVersionedScalar<T> {
    const record = this.#scalar(ref, 'array', 'readArray resource');
    const offset = scalarOffset(record, index, 'readArray index');
    const value = decodeScalar(
      record.scalarType,
      readBits(record.bytes, offset, record.width, 'little'),
    ) as StorageValue<T>;
    return Object.freeze({ value, dependencies: Object.freeze([this.#scalarUnit(record)]) });
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
    this.#assertWritable();
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
    this.#assertWritable();
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

  updateBytes(
    destination: BytesRef,
    destinationOffset: number,
    source: ReadableBytesRef,
    sourceOffset: number,
    length: number,
  ): void {
    this.#assertWritable();
    const target = this.#updateTarget(destination);
    const origin = this.#byte(source, false, 'resource.update_bytes source');
    const count = unsigned32(length, 'resource.update_bytes length');
    const start = byteOffset(
      target,
      destinationOffset,
      count,
      'resource.update_bytes destinationOffset',
    );
    const sourceStart = byteOffset(
      origin,
      sourceOffset,
      count,
      'resource.update_bytes sourceOffset',
    );
    if (count === 0) return;
    try {
      const bytes = origin.bytes.slice(sourceStart, sourceStart + count);
      const units = this.#prepareUnits(target, start, count, true);
      // No allocation, callbacks, or validation may intervene in this commit.
      target.bytes.set(bytes, start);
      this.#setUnits(target, units);
    } catch {
      throw new IRStorageError(
        'allocation-failure',
        'resource.update_bytes could not prepare its update',
      );
    }
  }

  fillBytes(destination: BytesRef, offset: number, length: number, value: number): void {
    this.#assertWritable();
    const target = this.#updateTarget(destination);
    const count = unsigned32(length, 'resource.fill_bytes length');
    const start = byteOffset(target, offset, count, 'resource.fill_bytes offset');
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new IRStorageError('invalid-value', 'resource.fill_bytes value must be a u8');
    }
    if (count === 0) return;
    try {
      const units = this.#prepareUnits(target, start, count, true);
      target.bytes.fill(value, start, start + count);
      this.#setUnits(target, units);
    } catch {
      throw new IRStorageError(
        'allocation-failure',
        'resource.fill_bytes could not prepare its update',
      );
    }
  }

  writeInbox(ref: InboxRef, offset: number, bytes: Uint8Array): void {
    this.#assertWritable();
    const record = this.#byte(ref, false, 'writeInbox resource');
    if (record.kind !== 'inbox') {
      throw new IRStorageError('invalid-resource', 'writeInbox requires an inbox resource');
    }
    const snapshot = captureBytes(bytes, 'writeInbox bytes');
    const start = byteOffset(record, offset, snapshot.length, 'writeInbox offset');
    if (snapshot.length === 0) return;
    try {
      // Inbox contents are host inputs; advance the whole-resource unit so tracked reads expire.
      const units = this.#prepareUnits(record, start, snapshot.length, true);
      record.bytes.set(snapshot, start);
      this.#setUnits(record, units);
    } catch {
      throw new IRStorageError('allocation-failure', 'writeInbox could not prepare its update');
    }
  }

  updateBytesFromBytes(ref: BytesRef, offset: number, bytes: Uint8Array): void {
    this.#assertWritable();
    const target = this.#updateTarget(ref);
    const snapshot = captureBytes(bytes, 'updateBytesFromBytes bytes');
    const start = byteOffset(target, offset, snapshot.length, 'updateBytesFromBytes offset');
    if (snapshot.length === 0) return;
    try {
      const units = this.#prepareUnits(target, start, snapshot.length, true);
      // No allocation, callbacks, or validation may intervene in this commit.
      target.bytes.set(snapshot, start);
      this.#setUnits(target, units);
    } catch {
      throw new IRStorageError(
        'allocation-failure',
        'updateBytesFromBytes could not prepare its update',
      );
    }
  }

  readVersionedBytes(ref: ReadableBytesRef, offset: number, length: number): IRVersionedBytes {
    const record = this.#byte(ref, false, 'readVersionedBytes resource');
    const count = unsigned32(length, 'readVersionedBytes length');
    const start = byteOffset(record, offset, count, 'readVersionedBytes offset');
    try {
      const bytes = record.bytes.slice(start, start + count);
      const units = this.#prepareUnits(record, start, count, false);
      const dependencies: IRResourceDependency[] = [];
      for (const index of coveredUnits(record, start, count)) dependencies.push(units.get(index)!);
      const result = Object.freeze({ bytes, dependencies: Object.freeze(dependencies) });
      this.#setUnits(record, units);
      return result;
    } catch {
      throw new IRStorageError('allocation-failure', 'Could not capture versioned bytes');
    }
  }

  validateDependencies(dependencies: readonly IRResourceDependency[]): boolean {
    if (!Array.isArray(dependencies)) return false;
    // Index iteration deliberately rejects holes as malformed dependencies.
    for (const dependency of dependencies) {
      if (dependency === null || typeof dependency !== 'object') return false;
      const metadata = this.#dependencies.get(dependency);
      if (metadata === undefined || metadata.record.units.get(metadata.index) !== dependency)
        return false;
    }
    return true;
  }

  #updateTarget(ref: object): ByteRecord {
    const record = this.#byte(ref, false, 'resource update destination');
    if (record.kind !== 'bytes') {
      throw new IRStorageError('invalid-resource', 'An inbox cannot be an update destination');
    }
    if (!this.#updateResources.has(ref)) {
      throw new IRStorageError(
        'unauthorized-resource',
        'Resource has no independent update authorization',
      );
    }
    return record;
  }

  #assertWritable(): void {
    if (this.#control.suspended > 0) {
      throw new IRStorageError(
        'unauthorized-resource',
        'Storage writes are suspended during provider generation',
      );
    }
  }

  /** Single mutation point for unit maps; keeps `control.epoch` in lockstep with `units`. */
  #setUnits(record: MemoryRecord, units: ReadonlyMap<number, IRResourceDependency>): void {
    record.units = units;
    this.#control.epoch += 1;
  }

  /** Whole-resource unit for scalar state/arrays; created lazily on the first tracked read. */
  #scalarUnit(record: ScalarRecord): IRResourceDependency {
    const previous = record.units.get(0);
    if (previous !== undefined) return previous;
    const dependency = freezeDependency(record.identity);
    this.#setUnits(record, new Map([[0, dependency]]));
    this.#dependencies.set(dependency, { record, index: 0 });
    return dependency;
  }

  /**
   * Ordinary scalar stores have no other versioned path, so they advance the whole-resource
   * unit. Runs with no tracked read are skipped; the first later read captures the then-current
   * value and needs no invalidation.
   */
  #advanceScalar(record: ScalarRecord): void {
    if (record.units.size === 0) return;
    const dependency = freezeDependency(record.identity);
    this.#setUnits(record, new Map([[0, dependency]]));
    this.#dependencies.set(dependency, { record, index: 0 });
  }

  #prepareUnits(
    record: ByteRecord,
    start: number,
    count: number,
    update: boolean,
  ): ReadonlyMap<number, IRResourceDependency> {
    if (count === 0) return record.units;
    const units = new Map(record.units);
    for (const index of coveredUnits(record, start, count)) {
      const previous = units.get(index);
      if (!update && previous !== undefined) continue;
      const dependency: IRResourceDependency = Object.freeze({
        resource: record.identity,
        unit: previous?.unit ?? (Object.freeze({}) as IRVersionUnitIdentity),
        version: Object.freeze({}) as IRResourceVersion,
      });
      units.set(index, dependency);
      this.#dependencies.set(dependency, { record, index });
    }
    return units;
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
    if ((record.kind !== 'bytes' && record.kind !== 'inbox') || !('unitBytes' in record)) {
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

/**
 * Advances the whole-resource unit for a scalar record after a JIT fast-path write. Mirrors the
 * tracked store path exactly: untracked records are ignored, tracked ones get a fresh token.
 */
export function advanceScalar(record: ScalarRecordInternals): void {
  const scalar = record as ScalarRecord;
  scalar.advance();
}

/** True when host typed arrays use little-endian byte order (every mainstream target). */
function detectLittleEndianHost(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

type ScalarView = NonNullable<ScalarRecordInternals['view']>;

/**
 * Prebuilds the JIT views over a record's freshly allocated buffer. Big-endian hosts get no
 * views; the JIT falls back to `DataView(bytes, ..., true)` there.
 */
function scalarViews(
  type: ScalarType,
  bytes: Uint8Array,
  length: number,
  littleEndianHost: boolean,
): { view: ScalarView | undefined; raw: Uint32Array | undefined } {
  if (!littleEndianHost) return { view: undefined, raw: undefined };
  const buffer = bytes.buffer;
  switch (type) {
    case 'bool':
    case 'u8':
      return { view: new Uint8Array(buffer, 0, length), raw: undefined };
    case 'i8':
      return { view: new Int8Array(buffer, 0, length), raw: undefined };
    case 'u16':
      return { view: new Uint16Array(buffer, 0, length), raw: undefined };
    case 'i16':
      return { view: new Int16Array(buffer, 0, length), raw: undefined };
    case 'u32':
      return { view: new Uint32Array(buffer, 0, length), raw: undefined };
    case 'i32':
      return { view: new Int32Array(buffer, 0, length), raw: undefined };
    case 'f32':
      return {
        view: new Float32Array(buffer, 0, length),
        raw: new Uint32Array(buffer, 0, length),
      };
    case 'f64':
      return {
        view: new Float64Array(buffer, 0, length),
        raw: new Uint32Array(buffer, 0, 2 * length),
      };
  }
}

function createRecord(
  definition: MemoryDefinition,
  control: StorageControl,
  littleEndianHost: boolean,
): MemoryRecord {
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
    const views = scalarViews(type, bytes, length, littleEndianHost);
    const record: ScalarRecord = {
      definition,
      ref: definition.ref,
      kind,
      writable: definition.writable,
      bytes,
      control,
      scalarType: type,
      length,
      width,
      view: views.view,
      raw: views.raw,
      tracked: () => record.units.size > 0,
      // Rebound by the owning storage so the closure can reach its dependency registry.
      advance: () => undefined,
      identity: Object.freeze({}) as IRResourceIdentity,
      units: new Map(),
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
      control,
      length,
      unitBytes,
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      identity: Object.freeze({}) as IRResourceIdentity,
      units: new Map(),
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

function* coveredUnits(record: ByteRecord, start: number, count: number): Generator<number> {
  if (count === 0) return;
  const first = Math.floor(start / record.unitBytes);
  const last = Math.floor((start + count - 1) / record.unitBytes);
  for (let index = first; index <= last; index += 1) yield index;
}

function captureBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new IRStorageError('invalid-argument', `${label} must be a Uint8Array`);
  }
  try {
    return value.slice();
  } catch {
    throw new IRStorageError('allocation-failure', `${label} could not be captured`);
  }
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
