/** Failure classification of a `HostFs.read` rejection. */
export type HostFsErrorCode = 'FileNotFound' | 'NoPermissions' | 'NoFileSystem' | 'Unavailable';

/**
 * Structured-clone payload for a `HostFsError` that crosses a thread boundary.
 *
 * The receiving side rebuilds the instance from `code`; `message` keeps the original wording when
 * it survives the transport and falls back to the default message for the code otherwise.
 */
export interface HostFsErrorPayload {
  readonly code: HostFsErrorCode;
  readonly uri: string;
  readonly message?: string;
}

export interface HostFsErrorOptions {
  readonly cause?: unknown;
}

const DEFAULT_MESSAGES: Record<HostFsErrorCode, string> = {
  FileNotFound: 'Host resource not found',
  NoPermissions: 'Host resource access denied',
  NoFileSystem: 'No host file system handles the URI scheme',
  Unavailable: 'Host file system is unavailable',
};

const ERROR_CODES: readonly HostFsErrorCode[] = [
  'FileNotFound',
  'NoPermissions',
  'NoFileSystem',
  'Unavailable',
];

function isHostFsErrorCode(value: unknown): value is HostFsErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Rejection of `HostFs.read`: `code` classifies the failure, `uri` names the resource. */
export class HostFsError extends Error {
  readonly code: HostFsErrorCode;
  readonly uri: string;

  constructor(
    code: HostFsErrorCode,
    uri: string,
    message?: string,
    options: HostFsErrorOptions = {},
  ) {
    super(
      message ?? `${DEFAULT_MESSAGES[code]}: ${uri}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'HostFsError';
    this.code = code;
    this.uri = uri;
  }
}

/** Narrows an unknown rejection to a `HostFsError` created in this realm. */
export function isHostFsError(value: unknown): value is HostFsError {
  return value instanceof HostFsError;
}

/** Copies the fields a thread hop must carry; the instance itself does not survive a structured clone. */
export function toHostFsErrorPayload(error: HostFsError): HostFsErrorPayload {
  return { code: error.code, uri: error.uri, message: error.message };
}

/** Rebuilds a `HostFsError` from its payload, rejecting codes outside the contract. */
export function fromHostFsErrorPayload(payload: HostFsErrorPayload): HostFsError {
  const code: unknown = payload.code;
  if (!isHostFsErrorCode(code)) {
    throw new TypeError(`Unknown HostFsError code: ${String(code)}`);
  }
  return new HostFsError(code, payload.uri, payload.message);
}
