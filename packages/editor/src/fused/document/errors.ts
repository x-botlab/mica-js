/**
 * Errors of the fused workbench document session.
 *
 * Every rejection carries a stable `code`; contract violations of `@mica-js/document/fused` and
 * package preparation problems keep their own code and JSON Pointer in `problems`, so the host can
 * report them without re-parsing anything.
 */
import { FusedDocumentError } from '@mica-js/document/fused';
import { PreparationError } from '@mica-js/sdk/fused';
import type { AccessDecision } from '../providers';

/** One problem behind a rejected document operation. */
export interface IFusedSessionProblem {
  readonly code: string;
  readonly message: string;
  /** JSON Pointer of the offending member; absent when the problem has no document location. */
  readonly pointer?: string;
}

export interface IFusedSessionErrorOptions {
  readonly problems?: readonly IFusedSessionProblem[];
  /** The access decision that denied the operation. */
  readonly decision?: AccessDecision;
  readonly cause?: unknown;
}

/** Rejection of one document session operation. */
export class FusedSessionError extends Error {
  readonly code: string;
  readonly problems: readonly IFusedSessionProblem[];
  readonly decision: AccessDecision | undefined;

  constructor(code: string, message: string, options: IFusedSessionErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FusedSessionError';
    this.code = code;
    this.problems = options.problems ?? [];
    this.decision = options.decision;
  }
}

/** Rejection of one operation by the access policy, carrying the decision that denied it. */
export function accessDenied(
  code: string,
  decision: Extract<AccessDecision, { readonly allowed: false }>,
): FusedSessionError {
  return new FusedSessionError(code, decision.message, { decision });
}

/** Normalizes any rejection into the session's error type, keeping contract diagnostics. */
export function toSessionError(
  cause: unknown,
  fallbackCode = 'edit/invalid-document',
): FusedSessionError {
  if (cause instanceof FusedSessionError) {
    return cause;
  }
  if (cause instanceof FusedDocumentError) {
    const problems = cause.diagnostics.map((entry) => ({
      code: entry.code,
      message: entry.message,
      ...(entry.pointer === '' ? {} : { pointer: entry.pointer }),
    }));
    return new FusedSessionError('edit/invalid-document', cause.message, {
      problems,
      cause,
    });
  }
  if (cause instanceof PreparationError) {
    return new FusedSessionError('device/unavailable', cause.message, {
      problems: cause.problems,
      cause,
    });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new FusedSessionError(fallbackCode, message, { cause });
}
