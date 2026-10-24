import type { IRJITTuning } from '@mica-js/ir';
import type { CircuitCompilationInput, DeviceDescription } from '../compiler';
import type { TeachingMCUAccessor } from '../examples/teaching-mcu/teaching-mcu.ac';

/**
 * Types of the unified circuit runtime (U02).
 *
 * `Circuit` is the host-facing facade over one compiled unified IR module: it
 * owns the engine instance, exposes typed per-device accessors and keeps the
 * tick counter. Everything here is transport-neutral; no type mentions the
 * scheduler, the device host or the schematic editor.
 */

/** Execution engine a `Circuit` runs on. */
export type CircuitEngine = 'jit' | 'reference';

/** Electrical-solve options forwarded to `compileCircuit`. */
export interface CircuitElectricalOptions {
  /**
   * Accept nets with more than one driver and solve them as a wired-OR.
   * Defaults to `false`, which reports a `driver-conflict` at compile time.
   */
  readonly allowMultiDriver?: boolean;
  /** Named fixed-level rails; merged over `GND`/`VCC`/`VDD`. */
  readonly rails?: Readonly<Record<string, boolean>>;
}

/**
 * Options for `Circuit.create`.
 *
 * @example
 * const circuit = await Circuit.create(input, { engine: 'reference' });
 */
export interface CircuitRuntimeOptions {
  /** Execution engine. Defaults to `'jit'`; `'reference'` runs the interpreter. */
  readonly engine?: CircuitEngine;
  /** JIT tuning. The runtime always supplies the module's own validation grant. */
  readonly jit?: IRJITTuning;
  /**
   * Run `validateIR` over the generated module during compilation.
   * Defaults to `true`; pass `false` only for measured warm paths.
   */
  readonly validateIR?: boolean;
  /** Electrical-solve options. */
  readonly electrical?: CircuitElectricalOptions;
  /** Instance id reported to the engine. Defaults to `'unified-circuit'`. */
  readonly instanceId?: string;
}

/** Error codes raised by `CircuitError`. */
export type CircuitErrorCode =
  | 'invalid-options'
  | 'invalid-count'
  | 'pin-not-found'
  | 'pin-not-writable'
  | 'state-not-found'
  | 'invalid-state-value'
  | 'register-not-found'
  | 'invalid-register-value'
  | 'unresolved-device'
  | 'disposed';

export interface CircuitErrorOptions {
  readonly deviceId?: string;
  readonly pinName?: string;
  readonly stateName?: string;
  readonly cause?: unknown;
}

/**
 * Error raised while driving a `Circuit`.
 *
 * The code is stable and machine-checkable, and the message always names the
 * offending device/pin/state plus the values that would have been accepted.
 */
export class CircuitError extends Error {
  override readonly name = 'CircuitError';
  readonly code: CircuitErrorCode;
  readonly deviceId: string | undefined;
  readonly pinName: string | undefined;
  readonly stateName: string | undefined;

  constructor(code: CircuitErrorCode, message: string, options: CircuitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.pinName = options.pinName;
    this.stateName = options.stateName;
  }
}

/**
 * What every device accessor offers, whatever its type.
 *
 * `readPin` returns the level the *device* drives onto one of its pins (its
 * output latch), while `Circuit.getPin('device.pin')` returns the level the pin
 * *observes* after the electrical solve. Writing a pin only makes sense for
 * driver pins, so `writePin` rejects load and passive pins.
 */
export interface DeviceAccessor {
  /** Circuit-unique device id. */
  readonly deviceId: string;
  /** Device type, e.g. `'teaching-mcu'`. */
  readonly type: string;
  /** Declared pin names, in declaration order. */
  readonly pinNames: readonly string[];
  /** Declared internal state names, in declaration order. */
  readonly stateNames: readonly string[];
  /** Reads the level the device drives onto `pinName`. */
  readPin(pinName: string): boolean;
  /** Writes the level the device drives onto `pinName`. */
  writePin(pinName: string, value: boolean): void;
  /** Reads one declared internal state. */
  getState(name: string): unknown;
  /** Writes one declared internal state. */
  setState(name: string, value: unknown): void;
}

/** Accessor of an LED-shaped device (`led`, `ideal-led`, …). */
export interface LedAccessor extends DeviceAccessor {
  /** Name of the boolean state `isOn()` reports. */
  readonly lampState: string;
  /** Lamps on when the anode senses high and the cathode low. */
  isOn(): boolean;
}

/** Accessor of an MCU-shaped device (`mcu`, `teaching-mcu`, …). */
export interface McuAccessor extends DeviceAccessor {
  /** Integer/bool states exposed as registers, in declaration order. */
  readonly registerNames: readonly string[];
  /** Reads one register as a bigint bit pattern. */
  readRegister(name: string): bigint;
  /** Writes one register; the value must fit the declared state type. */
  writeRegister(name: string, value: bigint): void;
}

/** Every accessor of one circuit, keyed by device id. */
export type DeviceAccessors = Readonly<Record<string, DeviceAccessor>>;

/**
 * Accessor type selected by a device type name.
 *
 * Unknown types fall back to `DeviceAccessor`, so custom devices keep the
 * generic state/pin surface without pretending to have lamps or registers.
 */
export type DeviceAccessorForType<T extends string> = T extends 'led' | 'ideal-led'
  ? LedAccessor
  : T extends 'mcu' | 'teaching-mcu'
    ? McuAccessor
    : T extends 'teaching-mcu-ir'
      ? TeachingMCUAccessor
      : DeviceAccessor;

/**
 * Accessor map derived from a literal compilation input.
 *
 * `Circuit.create` infers the device ids and types of a `const` input, so
 * `circuit.devices.led1.isOn()` type-checks without a cast while devices of
 * unknown types keep only the generic surface.
 */
export type DeviceAccessorsOf<I extends CircuitCompilationInput> = {
  readonly [D in I['devices'][number] as D['id']]: DeviceAccessorForType<D['type']>;
};

/**
 * Input of `createSingleDeviceCircuit`: one device named `device` whose type is
 * preserved so `circuit.devices.device` keeps the type-specific accessor.
 */
export interface SingleDeviceCircuitInput<
  T extends string = string,
> extends CircuitCompilationInput {
  readonly devices: readonly [
    {
      readonly id: 'device';
      readonly type: T;
      readonly description: DeviceDescription;
      readonly config?: Readonly<Record<string, unknown>>;
    },
  ];
  readonly connections: readonly [];
}
