import type { Diagnostic, DiagnosticCode, DiagnosticEntity } from './diagnostics';
import type { Placement, Point } from './types';

export function toPointer(path: readonly string[]): string {
  if (path.length === 0) {
    return '';
  }
  const segments = path.map((segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1'));
  return `/${segments.join('/')}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

export function report(
  diagnostics: Diagnostic[],
  code: DiagnosticCode,
  message: string,
  path: readonly string[],
  entity?: DiagnosticEntity,
): void {
  const diagnostic: Diagnostic = {
    severity: 'error',
    code,
    message,
    pointer: toPointer(path),
  };
  diagnostics.push(entity === undefined ? diagnostic : { ...diagnostic, entity });
}

export function forbidUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: readonly string[],
  diagnostics: Diagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      report(diagnostics, 'schema/unknown-field', `Unknown field "${key}".`, [...path, key]);
    }
  }
}

export interface StringFieldOptions {
  readonly nonEmpty?: boolean;
}

export function readStringField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: Diagnostic[],
  options: StringFieldOptions = {},
): string | undefined {
  const fieldPath = [...path, key];
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
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
  diagnostics: Diagnostic[],
): number | undefined {
  const fieldPath = [...path, key];
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
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
  diagnostics: Diagnostic[],
): number | undefined {
  const field = readNumberField(value, key, path, diagnostics);
  if (field === undefined) {
    return undefined;
  }
  if (!Number.isInteger(field)) {
    report(diagnostics, 'schema/invalid-value', `Field "${key}" must be an integer.`, [
      ...path,
      key,
    ]);
    return undefined;
  }
  return field;
}

export function readArrayField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: Diagnostic[],
): unknown[] | undefined {
  const fieldPath = [...path, key];
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    return undefined;
  }
  const field = value[key];
  if (!Array.isArray(field)) {
    report(diagnostics, 'schema/invalid-type', `Field "${key}" must be an array.`, fieldPath);
    return undefined;
  }
  return field;
}

export function readObjectField(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: Diagnostic[],
): Record<string, unknown> | undefined {
  const fieldPath = [...path, key];
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    report(diagnostics, 'schema/missing-field', `Missing required field "${key}".`, fieldPath);
    return undefined;
  }
  const field = value[key];
  if (!isRecord(field)) {
    report(diagnostics, 'schema/invalid-type', `Field "${key}" must be an object.`, fieldPath);
    return undefined;
  }
  return field;
}

export function readPoint(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): Point | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Point must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['x', 'y'], path, diagnostics);
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x, y };
}

export function readPlacement(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): Placement | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Placement must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['x', 'y', 'rotation'], path, diagnostics);
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  const rotation = readNumberField(value, 'rotation', path, diagnostics);
  if (x === undefined || y === undefined || rotation === undefined) {
    return undefined;
  }
  return { x, y, rotation };
}

export interface IdentifiedEntry {
  readonly id: string;
  readonly path: readonly string[];
}

export function checkDuplicateIds(
  entries: readonly IdentifiedEntry[],
  kind: DiagnosticEntity['kind'],
  diagnostics: Diagnostic[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      report(diagnostics, 'id/duplicate', `Duplicate ${kind} id "${entry.id}".`, entry.path, {
        kind,
        id: entry.id,
      });
      continue;
    }
    seen.add(entry.id);
  }
}
