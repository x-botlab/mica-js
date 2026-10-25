import type { Diagnostic, DiagnosticCode } from './diagnostics';

/**
 * Stable error codes for schema conformance failures, shared by the format and device layers.
 * The key is the contract; the value is a human-readable description for generic tooling.
 * A specific failure adds its own detailed message next to the code.
 */
export const SCHEMA_ERROR_CODES = {
  'schema/invalid-value': 'The value does not conform to the schema',
  'schema/unknown-field': 'Unknown field in object',
  'schema/type-mismatch': 'Type does not match expected type',
} as const;

/** One code from the {@link SCHEMA_ERROR_CODES} contract. */
export type SchemaErrorCode = keyof typeof SCHEMA_ERROR_CODES;

/**
 * Thrown when input violates the schematic format contract.
 * `diagnostics` carries every problem found, so callers can report them all at once.
 */
export class SchematicError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(buildMessage(diagnostics));
    this.name = 'SchematicError';
    this.diagnostics = diagnostics;
  }

  /** Code of the first diagnostic, for coarse programmatic handling. */
  get code(): DiagnosticCode | undefined {
    return this.diagnostics[0]?.code;
  }
}

function buildMessage(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const relevant = errors.length > 0 ? errors : diagnostics;
  const [first, ...rest] = relevant;
  if (first === undefined) {
    return 'Schematic validation failed.';
  }
  const location =
    first.pointer === undefined || first.pointer === '' ? '' : ` at ${first.pointer}`;
  const suffix = rest.length === 0 ? '' : ` (and ${rest.length} more)`;
  return `${first.code}${location}: ${first.message}${suffix}`;
}

export function throwIfErrors(diagnostics: readonly Diagnostic[]): void {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new SchematicError(diagnostics);
  }
}
