import type { IRJITTuning } from '@mica-js/ir';
import type { CircuitCompilationInput, CircuitCompilationOptions } from '../compiler';

/**
 * Types of the unified circuit runtime (U02).
 *
 * `Circuit` is the host-facing facade over one compiled unified IR module: it
 * owns the engine instance, exposes typed per-device accessors and keeps the
 * tick counter. Everything here is transport-neutral; no type mentions the
 * device host or the schematic editor.
 */

export type ElectricalCurrentTarget =
  | { readonly kind: 'resistor' | 'contact'; readonly device: string; readonly name: string }
  | {
      readonly kind: 'drive' | 'pull-up' | 'pull-down';
      readonly device: string;
      readonly pin: string;
    }
  | { readonly kind: 'source'; readonly name: string };

/** Active diagnostics of the last published electrical snapshot, plus any latched solve fault. */
export type ElectricalDiagnostic =
  | {
      readonly code: 'electrical/overcurrent';
      readonly severity: 'warning';
      readonly target: ElectricalCurrentTarget;
      readonly current: number;
      readonly maxAbsCurrent: number;
    }
  | {
      readonly code:
        | 'electrical/invalid-parameter'
        | 'electrical/source-conflict'
        | 'electrical/numerical-failure';
      readonly severity: 'error';
      /** Identifiable failed operation or resource; absent for a matrix-level failure. */
      readonly target?: ElectricalCurrentTarget;
      /** Resources associated with the affected network, not a list of proven culprits. */
      readonly resources: readonly ElectricalCurrentTarget[];
      readonly pins: readonly string[];
    };

/** Execution engine a `Circuit` runs on. */
export type CircuitEngine = 'jit' | 'reference';

/** Electrical-solve options forwarded to `compileCircuit`. */
export interface CircuitElectricalOptions {
  readonly sources?: CircuitCompilationOptions['sources'];
  readonly interpretation?: CircuitCompilationOptions['interpretation'];
  readonly floatingSeed?: CircuitCompilationOptions['floatingSeed'];
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
  | 'unsupported-operation'
  | 'resource-not-found'
  | 'pin-not-found'
  | 'state-not-found'
  | 'invalid-state-value'
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
 * *observes* after the electrical solve. Host changes use device state; there
 * is no direct pin override API.
 */
export interface DeviceAccessor {
  /** Circuit-unique device id. */
  readonly deviceId: string;
  /** Device type, e.g. `'push-pull-driver'`. */
  readonly type: string;
  /** Declared pin names, in declaration order. */
  readonly pinNames: readonly string[];
  /** Declared internal state names, in declaration order. */
  readonly stateNames: readonly string[];
  /** Reads the level the device drives onto `pinName`. */
  readPin(pinName: string): boolean;
  /** Writes the level the device drives onto `pinName`. */
  /** Reads one declared internal state. */
  getState(name: string): unknown;
  /** Writes one declared internal state. */
  setState(name: string, value: unknown): void;
}

/** Every accessor of one circuit, keyed by device id. */
export type DeviceAccessors = Readonly<Record<string, DeviceAccessor>>;

/**
 * Accessor map derived from a literal compilation input.
 *
 * `Circuit.create` infers the device ids of a `const` input, so
 * `circuit.devices.<id>` is typed without a cast. A device package that wants a
 * richer surface builds it through `DeviceDescription.accessor` and casts at
 * the call site.
 */
export type DeviceAccessorsOf<I extends CircuitCompilationInput> = {
  readonly [D in I['devices'][number] as D['id']]: DeviceAccessor;
};
