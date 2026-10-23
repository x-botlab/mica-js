import type { IRDiagnostic } from './validation-types';

export class IRConstructionError extends Error {
  override readonly name = 'IRConstructionError';
}

export function fail(message: string): never {
  throw new IRConstructionError(message);
}

export type IRProviderErrorCode =
  | 'invalid-provider'
  | 'key-mismatch'
  | 'unauthorized-read'
  | 'invalid-read'
  | 'generation-failed'
  | 'invalid-artifact'
  | 'import-violation'
  | 'dependency-changed'
  | 'illegal-operation'
  | 'recovery-failed';

export interface IRProviderErrorDetails {
  readonly cause?: unknown;
  readonly diagnostics?: readonly IRDiagnostic[];
}

/** Provider declaration, generation, artifact and cache failures (#60). */
export class IRProviderError extends Error {
  override readonly name = 'IRProviderError';
  override readonly cause: unknown;
  readonly diagnostics: readonly IRDiagnostic[];

  constructor(
    readonly code: IRProviderErrorCode,
    message: string,
    details: IRProviderErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.cause = details.cause;
    this.diagnostics = details.diagnostics ?? [];
  }
}
