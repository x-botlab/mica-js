import type { Diagnostic } from './diagnostics';

export interface ParseResult<T> {
  readonly ok: boolean;
  readonly value: T | undefined;
  readonly diagnostics: readonly Diagnostic[];
}
