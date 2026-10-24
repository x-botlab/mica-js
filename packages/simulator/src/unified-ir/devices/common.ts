import type { ArrayRef, IRModule, RuntimeScalar, ScalarType, StateRef } from '@mica-js/ir';
import { PIN_MODE } from '../types';

/**
 * Shared building blocks of the simple unified-IR devices (U04).
 *
 * LED and button are small enough to declare their state with `module.state`
 * and their pins through the shared `pin_mode` / `pin_output` / `pin_input`
 * memories, so they only need the storage subset below. Keeping the common
 * pieces in one place makes the two device implementations structurally equal
 * to `examples/teaching-mcu` without copying the same helpers twice.
 */

/** Device ids prefix IR function names, so they must be identifiers. */
export const DEVICE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `value` can be used as a device id (and IR function prefix). */
export function isDeviceIdentifier(value: string): boolean {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

/**
 * Storage subset a simple-device accessor needs; `IRStorage` satisfies it
 * structurally.
 */
export interface StorageAccessor {
  loadState<T extends ScalarType>(ref: StateRef<T>): RuntimeScalar;
  storeState<T extends ScalarType>(ref: StateRef<T>, value: RuntimeScalar): void;
  loadArray<T extends ScalarType>(ref: ArrayRef<T>, index: number): RuntimeScalar;
  storeArray<T extends ScalarType>(ref: ArrayRef<T>, index: number, value: RuntimeScalar): void;
}

/** The three shared pin memories, structurally equal to `CompiledCircuitMemory`. */
export interface SimplePinMemory {
  readonly mode: ArrayRef<'u8'>;
  readonly output: ArrayRef<'bool'>;
  readonly input: ArrayRef<'bool'>;
}

/** One declared pin resolved into the global pin space. */
export interface SimpleDevicePin {
  readonly name: string;
  readonly globalPinId: number;
}

/** Optional host services shared by the simple-device accessors. */
export interface SimpleDeviceAccessorOptions {
  /** Invoked before every access; the owning circuit throws once disposed. */
  readonly assertActive?: () => void;
  /** Executes one circuit tick. */
  readonly step?: () => void;
  /** Executes `count` circuit ticks in one engine call. */
  readonly runBatch?: (count: number) => void;
}

/** Creates the standalone pin memories of a device that runs outside a circuit. */
export function createStandalonePinMemory(
  module: IRModule,
  deviceId: string,
  pinCount: number,
): SimplePinMemory {
  return Object.freeze({
    mode: module.array(
      `${deviceId}_pin_mode`,
      'u8',
      Array.from({ length: pinCount }, () => PIN_MODE.highZ),
    ),
    output: module.array(
      `${deviceId}_pin_output`,
      'bool',
      Array.from({ length: pinCount }, () => false),
    ),
    input: module.array(
      `${deviceId}_pin_input`,
      'bool',
      Array.from({ length: pinCount }, () => false),
    ),
  });
}

/**
 * Maps the declared pin names to global pin ids.
 *
 * A standalone module numbers its pins from zero; a circuit kernel passes the
 * ids the allocator handed out and the names must match the description.
 */
export function resolvePinIds(
  deviceId: string,
  names: readonly string[],
  pinIds: ReadonlyMap<string, number> | undefined,
  unknownPin: (deviceId: string, pinName: string) => Error,
): ReadonlyMap<string, number> {
  if (pinIds === undefined) {
    return new Map(names.map((name, index) => [name, index]));
  }
  for (const name of pinIds.keys()) {
    if (!names.includes(name)) throw unknownPin(deviceId, name);
  }
  const resolved = new Map<string, number>();
  for (const name of names) {
    const globalPinId = pinIds.get(name);
    if (globalPinId === undefined) throw unknownPin(deviceId, name);
    resolved.set(name, globalPinId);
  }
  return resolved;
}

/** Reads one boolean state slot. */
export function loadBool(storage: StorageAccessor, ref: StateRef<'bool'>): boolean {
  return storage.loadState(ref) === true;
}

/** Reads one integer state slot as a JS number. */
export function loadNumber(
  storage: StorageAccessor,
  ref: StateRef<'u8'> | StateRef<'u32'>,
): number {
  return Number(storage.loadState(ref));
}
