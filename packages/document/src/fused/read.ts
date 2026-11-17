/** Structural readers shared by the fused parsers; every failure reports code and field path. */
import { report, toPointer } from './diagnostics';
import type { FusedDiagnostic } from './diagnostics';
import { decodeStrictJson } from './json';

export { report, toPointer };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasErrors(diagnostics: readonly FusedDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

export function forbidUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      report(diagnostics, 'schema/unknown-field', `Unknown field "${key}".`, [...path, key]);
    }
  }
}

export interface JsonInput {
  readonly ok: boolean;
  readonly value: unknown;
}

/**
 * Strings are decoded as strict JSON text, which rejects duplicate keys; any other value is
 * validated as-is so callers that already hold a plain object stay supported.
 */
export function parseJsonInput(input: unknown, diagnostics: FusedDiagnostic[]): JsonInput {
  if (typeof input !== 'string') {
    return { ok: true, value: input };
  }
  const decoded = decodeStrictJson(input);
  if (!decoded.ok) {
    diagnostics.push(...decoded.diagnostics);
    return { ok: false, value: undefined };
  }
  return { ok: true, value: decoded.value };
}

export interface TextOptions {
  readonly nonEmpty?: boolean;
}

export function readStringField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  required = true,
  options: TextOptions = {},
): string | undefined {
  const fieldPath = [...path, key];
  if (!hasOwn(value, key)) {
    if (required) {
      report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    }
    return undefined;
  }
  const field = value[key];
  if (typeof field !== 'string') {
    report(diagnostics, 'schema/invalid-type', `Field "${key}" must be a string.`, fieldPath);
    return undefined;
  }
  if (options.nonEmpty === true && field.length === 0) {
    report(diagnostics, 'schema/invalid-value', `Field "${key}" must not be empty.`, fieldPath);
    return undefined;
  }
  return field;
}

export function readNumberField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  required = true,
): number | undefined {
  const fieldPath = [...path, key];
  if (!hasOwn(value, key)) {
    if (required) {
      report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    }
    return undefined;
  }
  const field = value[key];
  if (typeof field !== 'number') {
    report(diagnostics, 'schema/invalid-type', `Field "${key}" must be a number.`, fieldPath);
    return undefined;
  }
  if (!Number.isFinite(field)) {
    report(
      diagnostics,
      'schema/invalid-value',
      `Field "${key}" must be a finite number.`,
      fieldPath,
    );
    return undefined;
  }
  return field;
}

export function readIntegerField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  required = true,
): number | undefined {
  const field = readNumberField(value, key, path, diagnostics, required);
  if (field === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(field)) {
    report(diagnostics, 'schema/invalid-value', `Field "${key}" must be a safe integer.`, [
      ...path,
      key,
    ]);
    return undefined;
  }
  return field;
}

export function readBooleanField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  required = true,
): boolean | undefined {
  const fieldPath = [...path, key];
  if (!hasOwn(value, key)) {
    if (required) {
      report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    }
    return undefined;
  }
  const field = value[key];
  if (typeof field !== 'boolean') {
    report(diagnostics, 'schema/invalid-type', `Field "${key}" must be a boolean.`, fieldPath);
    return undefined;
  }
  return field;
}

export function readObjectField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  required = true,
): Record<string, unknown> | undefined {
  const fieldPath = [...path, key];
  if (!hasOwn(value, key)) {
    if (required) {
      report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    }
    return undefined;
  }
  const field = value[key];
  if (!isRecord(field)) {
    report(diagnostics, 'schema/invalid-type', `Field "${key}" must be an object.`, fieldPath);
    return undefined;
  }
  return field;
}

export function readArrayField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  required = true,
): unknown[] | undefined {
  const fieldPath = [...path, key];
  if (!hasOwn(value, key)) {
    if (required) {
      report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    }
    return undefined;
  }
  const field = value[key];
  if (!Array.isArray(field)) {
    report(diagnostics, 'schema/invalid-type', `Field "${key}" must be an array.`, fieldPath);
    return undefined;
  }
  return field;
}

/** Compares two strings by UTF-16 code unit, independent of the host locale. */
export function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Records an immutable snapshot of a parsed structure.
 *
 * Parsers only build plain objects and arrays, so freezing them is safe; array-buffer views are
 * left alone because their contents cannot be frozen.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}
