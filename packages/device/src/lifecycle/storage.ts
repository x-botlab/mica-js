import type {
  ArrayRef,
  BytesRef,
  Endian,
  IRResourceDependency,
  IRStorage,
  IRVersionedBytes,
  NumericType,
  ReadableBytesRef,
  RuntimeScalar,
  ScalarType,
  StateRef,
  StorageValue,
  WritableBytesRef,
} from '@mica-js/ir';
import { DeviceError } from '../errors';

/**
 * Guards the host-visible storage handle. After `release()` every accessor throws and the guard
 * no longer retains the kernel storage, so an external handle cannot keep it reachable.
 */
export class LifecycleStorage implements IRStorage {
  #storage: IRStorage | undefined;
  readonly #deviceId: string;

  constructor(storage: IRStorage, deviceId: string) {
    this.#storage = storage;
    this.#deviceId = deviceId;
  }

  release(): void {
    this.#storage = undefined;
  }

  #live(operation: string): IRStorage {
    if (this.#storage === undefined) {
      throw new DeviceError(
        'device/instance-destroyed',
        `Device ${JSON.stringify(this.#deviceId)} storage.${operation} is unavailable after destroy.`,
        { deviceId: this.#deviceId },
      );
    }
    return this.#storage;
  }

  loadState<T extends ScalarType>(ref: StateRef<T>): StorageValue<T> {
    return this.#live('loadState').loadState(ref);
  }
  storeState<T extends ScalarType>(ref: StateRef<T>, value: RuntimeScalar): void {
    this.#live('storeState').storeState(ref, value);
  }
  loadArray<T extends ScalarType>(ref: ArrayRef<T>, index: number): StorageValue<T> {
    return this.#live('loadArray').loadArray(ref, index);
  }
  storeArray<T extends ScalarType>(ref: ArrayRef<T>, index: number, value: RuntimeScalar): void {
    this.#live('storeArray').storeArray(ref, index, value);
  }
  loadBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: ReadableBytesRef,
    offset: number,
  ): StorageValue<T> {
    return this.#live('loadBytes').loadBytes(type, endian, ref, offset);
  }
  storeBytes<T extends NumericType>(
    type: T,
    endian: Endian,
    ref: WritableBytesRef,
    offset: number,
    value: RuntimeScalar,
  ): void {
    this.#live('storeBytes').storeBytes(type, endian, ref, offset, value);
  }
  copy(
    destination: WritableBytesRef,
    destinationOffset: number,
    source: ReadableBytesRef,
    sourceOffset: number,
    length: number,
  ): void {
    this.#live('copy').copy(destination, destinationOffset, source, sourceOffset, length);
  }
  updateBytes(
    destination: BytesRef,
    destinationOffset: number,
    source: ReadableBytesRef,
    sourceOffset: number,
    length: number,
  ): void {
    this.#live('updateBytes').updateBytes(
      destination,
      destinationOffset,
      source,
      sourceOffset,
      length,
    );
  }
  fillBytes(destination: BytesRef, offset: number, length: number, value: number): void {
    this.#live('fillBytes').fillBytes(destination, offset, length, value);
  }
  readVersionedBytes(ref: ReadableBytesRef, offset: number, length: number): IRVersionedBytes {
    return this.#live('readVersionedBytes').readVersionedBytes(ref, offset, length);
  }
  validateDependencies(dependencies: readonly IRResourceDependency[]): boolean {
    return this.#live('validateDependencies').validateDependencies(dependencies);
  }
}
