import { DeviceError } from '../errors';
import type { DeviceErrorCode } from '../errors';

export type BackpressureOperation = 'post' | 'postBytes' | 'publish' | 'deliver' | 'updateBytes';

/** Expected admission failure; callers may handle it without turning it into a model error. */
export class BackpressureError extends Error {
  override readonly name = 'BackpressureError';
  readonly operation: BackpressureOperation;

  constructor(operation: BackpressureOperation, message: string) {
    super(message);
    this.operation = operation;
  }
}

export function messagingError(
  code: DeviceErrorCode,
  deviceId: string,
  message: string,
  cause?: unknown,
): DeviceError {
  return new DeviceError(code, `Device ${JSON.stringify(deviceId)} ${message}`, {
    deviceId,
    ...(cause === undefined ? {} : { cause }),
  });
}
