export type DeviceErrorCode =
  | 'device/device-unknown'
  | 'device/provider-failed'
  | 'device/description-schema'
  | 'device/implementation-import'
  | 'device/implementation-export'
  | 'device/implementation-async'
  | 'device/factory-failed'
  | 'device/factory-async'
  | 'device/factory-closed'
  | 'device/lifecycle-binding'
  | 'device/lifecycle-unsupported'
  | 'device/link-failed'
  | 'device/instance-invalid'
  | 'device/instance-busy'
  | 'device/instance-destroyed'
  | 'device/dispose-failed'
  | 'device/topic-unknown'
  | 'device/topic-direction'
  | 'device/topic-payload'
  | 'device/topic-subscription'
  | 'device/output-unknown'
  | 'device/output-consumer'
  | 'device/message-target'
  | 'device/inbox-reference'
  | 'device/update-target'
  | 'device/message-callback'
  | 'device/not-active'
  | 'schema/invalid-type'
  | 'schema/invalid-value'
  | 'schema/unknown-field'
  | 'type/unknown';

export interface DeviceErrorOptions {
  readonly deviceId?: string;
  readonly pointer?: string;
  readonly cause?: unknown;
}

/** Error raised by device loading and property resolution. */
export class DeviceError extends Error {
  override readonly name = 'DeviceError';
  readonly code: DeviceErrorCode;
  readonly deviceId: string | undefined;
  /** JSON Pointer into the declaration or metadata that failed validation. */
  readonly pointer: string | undefined;

  constructor(code: DeviceErrorCode, message: string, options: DeviceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.deviceId = options.deviceId;
    this.pointer = options.pointer;
  }
}
