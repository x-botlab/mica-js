import type { Diagnostic } from './diagnostics';

export interface ParsedInput {
  readonly ok: boolean;
  readonly value: unknown;
}

/** Strings are parsed as JSON text; any other value is validated as-is. */
export function parseInput(input: string | unknown, diagnostics: Diagnostic[]): ParsedInput {
  if (typeof input !== 'string') {
    return { ok: true, value: input };
  }
  try {
    return { ok: true, value: JSON.parse(input) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    diagnostics.push({
      severity: 'error',
      code: 'json/invalid',
      message: `Invalid JSON: ${detail}`,
    });
    return { ok: false, value: undefined };
  }
}
