/** Error codes raised by the unified-IR LED device. */
export type LedErrorCode =
  | 'invalid-config'
  | 'invalid-device-id'
  | 'unknown-pin'
  | 'unknown-state'
  | 'invalid-value'
  | 'pin-not-writable'
  | 'layout-not-found'
  | 'no-runner';

export interface LedErrorOptions {
  readonly deviceId?: string;
  readonly pinName?: string;
  readonly stateName?: string;
  readonly cause?: unknown;
}

/**
 * Error raised while configuring or driving a unified-IR LED.
 *
 * The code is stable and machine-checkable, and the message names the offending
 * device, pin or state plus the values that would have been accepted.
 */
export class LedError extends Error {
  override readonly name = 'LedError';
  readonly code: LedErrorCode;
  readonly deviceId: string | undefined;
  readonly pinName: string | undefined;
  readonly stateName: string | undefined;

  constructor(code: LedErrorCode, message: string, options: LedErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.pinName = options.pinName;
    this.stateName = options.stateName;
  }
}
