/** Error codes raised by the unified-IR button device. */
export type ButtonErrorCode =
  | 'invalid-config'
  | 'invalid-device-id'
  | 'unknown-pin'
  | 'unknown-state'
  | 'invalid-value'
  | 'pin-not-writable'
  | 'layout-not-found'
  | 'no-runner';

export interface ButtonErrorOptions {
  readonly deviceId?: string;
  readonly pinName?: string;
  readonly stateName?: string;
  readonly cause?: unknown;
}

/**
 * Error raised while configuring or driving a unified-IR button.
 *
 * The code is stable and machine-checkable, and the message names the
 * offending device, pin or state plus the values that would have been accepted.
 */
export class ButtonError extends Error {
  override readonly name = 'ButtonError';
  readonly code: ButtonErrorCode;
  readonly deviceId: string | undefined;
  readonly pinName: string | undefined;
  readonly stateName: string | undefined;

  constructor(code: ButtonErrorCode, message: string, options: ButtonErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.pinName = options.pinName;
    this.stateName = options.stateName;
  }
}
