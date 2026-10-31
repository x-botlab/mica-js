import type { IRJITTuning } from '@mica-js/ir';
import type { CircuitCompilationOptions } from '../compiler';

/**
 * Types of the unified circuit runtime (U02).
 *
 * `Circuit` is the host-facing facade over one compiled unified IR module: it
 * owns the engine instance, the tick counter and the private step-boundary hook
 * plumbing. Everything here is transport-neutral; no type mentions the device
 * host or the schematic editor.
 */

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
  | 'state-not-found'
  | 'invalid-state-value'
  | 'unresolved-device'
  | 'disposed';

export interface CircuitErrorOptions {
  readonly deviceId?: string;
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
  readonly stateName: string | undefined;

  constructor(code: CircuitErrorCode, message: string, options: CircuitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.stateName = options.stateName;
  }
}
