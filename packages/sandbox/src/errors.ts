import type { SerializedError } from './protocol';

export type SandboxErrorCode =
  | 'invalid-options'
  | 'unsupported-environment'
  | 'source-fetch'
  | 'trusted-types'
  | 'frame-error'
  | 'boot-timeout'
  | 'boot-failed'
  | 'timeout'
  | 'terminated'
  | 'capability-not-found'
  | 'capability-failed'
  | 'method-not-found'
  | 'guest-error'
  | 'protocol';

export interface SandboxErrorOptions {
  cause?: unknown;
  remoteStack?: string;
}

/** Error type used across the sandbox boundary; `remoteStack` holds the stack from the other side. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly remoteStack: string | undefined;

  constructor(code: SandboxErrorCode, message: string, options: SandboxErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SandboxError';
    this.code = code;
    this.remoteStack = options.remoteStack;
  }
}

export function deserializeError(error: SerializedError): SandboxError {
  const code = isSandboxErrorCode(error.code) ? error.code : 'guest-error';
  return error.stack === undefined
    ? new SandboxError(code, error.message)
    : new SandboxError(code, error.message, { remoteStack: error.stack });
}

function isSandboxErrorCode(value: unknown): value is SandboxErrorCode {
  return (
    typeof value === 'string' &&
    [
      'invalid-options',
      'unsupported-environment',
      'source-fetch',
      'trusted-types',
      'frame-error',
      'boot-timeout',
      'boot-failed',
      'timeout',
      'terminated',
      'capability-not-found',
      'capability-failed',
      'method-not-found',
      'guest-error',
      'protocol',
    ].includes(value)
  );
}
