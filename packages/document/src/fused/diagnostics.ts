/** Diagnostics of the fused device package and fused `.sch` contracts. */

export type FusedDiagnosticSeverity = 'error' | 'warning';

/**
 * Stable diagnostic codes of the fused contracts.
 *
 * The codes follow the RFC 0020 / 0021 / 0022 / 0024 / 0026 tables. `json/*` and `schema/*` cover
 * structural problems, `package/*` manifest and path problems, and the remaining families cover
 * the named runtime contract they belong to.
 */
export type FusedDiagnosticCode =
  | 'json/invalid'
  | 'json/duplicate-key'
  | 'json/not-object'
  | 'schema/unsupported-version'
  | 'schema/missing-field'
  | 'schema/invalid-type'
  | 'schema/invalid-value'
  | 'schema/unknown-field'
  | 'package/invalid-manifest'
  | 'package/invalid-path'
  | 'package/invalid-icon'
  | 'package/unsupported-engine'
  | 'document/duplicate-id'
  | 'document/duplicate-designator'
  | 'document/unlocked-device'
  | 'document/invalid-view-layout'
  | 'connection/unknown-endpoint'
  | 'connection/self-edge'
  | 'net/naming-conflict'
  | 'net/reference-conflict'
  | 'device/unresolved'
  | 'device/unknown-pin'
  | 'model/invalid-interface'
  | 'model/invalid-params'
  | 'model/invalid-result'
  | 'model/invalid-event'
  | 'type/unknown'
  | 'view2d/invalid-geometry'
  | 'view2d/pin-mismatch'
  | 'firmware/invalid-image'
  | 'firmware/out-of-range';

/** JSON Pointer of a field path; segments escape `~` and `/` (RFC 6901). */
export function toPointer(path: readonly string[]): string {
  if (path.length === 0) {
    return '';
  }
  const segments = path.map((segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1'));
  return `/${segments.join('/')}`;
}

/** One problem found while validating fused device data. */
export interface FusedDiagnostic {
  readonly severity: FusedDiagnosticSeverity;
  /** Stable contract code; the human readable `message` is not part of the contract. */
  readonly code: FusedDiagnosticCode;
  readonly message: string;
  /** JSON Pointer of the offending member; the empty string addresses the whole document. */
  readonly pointer: string;
}

/**
 * Thrown when fused device data violates its contract.
 *
 * `diagnostics` carries every problem found, each with an explicit code and JSON Pointer, so a
 * host can report them without re-parsing.
 */
export class FusedDocumentError extends Error {
  readonly diagnostics: readonly FusedDiagnostic[];

  constructor(diagnostics: readonly FusedDiagnostic[]) {
    super(buildMessage(diagnostics));
    this.name = 'FusedDocumentError';
    this.diagnostics = diagnostics;
  }

  /** Code of the first diagnostic, for coarse programmatic handling. */
  get code(): FusedDiagnosticCode | undefined {
    return this.diagnostics[0]?.code;
  }

  /** Field path of the first diagnostic, for coarse programmatic handling. */
  get pointer(): string | undefined {
    return this.diagnostics[0]?.pointer;
  }
}

/** Records one diagnostic for `path` as an error. */
export function report(
  diagnostics: FusedDiagnostic[],
  code: FusedDiagnosticCode,
  message: string,
  path: readonly string[],
): void {
  diagnostics.push({ severity: 'error', code, message, pointer: toPointer(path) });
}

function buildMessage(diagnostics: readonly FusedDiagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const relevant = errors.length > 0 ? errors : diagnostics;
  const [first, ...rest] = relevant;
  if (first === undefined) {
    return 'Fused device validation failed.';
  }
  const location = first.pointer === '' ? '' : ` at ${first.pointer}`;
  const suffix = rest.length === 0 ? '' : ` (and ${rest.length} more)`;
  return `${first.code}${location}: ${first.message}${suffix}`;
}
