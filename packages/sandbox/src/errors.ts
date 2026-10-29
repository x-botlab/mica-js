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
