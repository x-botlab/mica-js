/**
 * Error surface shared by the teaching MCU IR factory and its accessor.
 *
 * Kept in its own module so `teaching-mcu.ts` (factory) and
 * `teaching-mcu.ac.ts` (accessor) can both import the class without a runtime
 * cycle.
 */

/** Stable error codes raised by the unified teaching MCU. */
export type TeachingMCUErrorCode =
  | 'invalid-config'
  | 'unknown-pin'
  | 'layout-not-found'
  | 'no-runner'
  | 'unknown-register'
  | 'unknown-state'
  | 'unknown-port'
  | 'invalid-value'
  | 'address-out-of-range'
  | 'flash-write'
  | 'update-unsupported'
  | 'disposed';

export interface TeachingMCUErrorOptions {
  readonly deviceId?: string;
  readonly pinName?: string;
  readonly stateName?: string;
  readonly address?: number;
}

/** Raised when a teaching MCU configuration or accessor call is invalid. */
export class TeachingMCUError extends Error {
  override readonly name = 'TeachingMCUError';
  readonly code: TeachingMCUErrorCode;
  readonly deviceId: string | undefined;
  readonly pinName: string | undefined;
  readonly stateName: string | undefined;
  readonly address: number | undefined;

  constructor(code: TeachingMCUErrorCode, message: string, options: TeachingMCUErrorOptions = {}) {
    super(message);
    this.code = code;
    this.deviceId = options.deviceId;
    this.pinName = options.pinName;
    this.stateName = options.stateName;
    this.address = options.address;
  }
}
