import type { Diagnostic, DiagnosticCode, DiagnosticEntity } from './diagnostics';
import type { AssetMode, AssetReference, Point, PropertyValue } from './value';
import { assetSrcError, isAssetMode } from './value';

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

export interface IdentifiedEntry {
  readonly id: string;
  readonly path: readonly string[];
}

/**
 * Reads an `image` / `binary` property value: a resource reference `{ "src", "mode" }` (#7).
 * `src` is checked against the rules of its mode; content itself lives outside the document.
 */
export function readAssetReference(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): AssetReference | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Resource reference must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['src', 'mode'], path, diagnostics);
  const src = readStringField(value, 'src', path, diagnostics, { nonEmpty: true });
  let mode: AssetMode | undefined;
  if (!Object.prototype.hasOwnProperty.call(value, 'mode')) {
    report(diagnostics, 'schema/missing-field', 'Missing required field "mode".', [
      ...path,
      'mode',
    ]);
  } else if (isAssetMode(value['mode'])) {
    mode = value['mode'];
  } else {
    report(
      diagnostics,
      'schema/invalid-value',
      'Field "mode" must be "file", "inline" or "store".',
      [...path, 'mode'],
    );
  }
  if (src === undefined || mode === undefined) {
    return undefined;
  }
  const srcError = assetSrcError(mode, src);
  if (srcError !== undefined) {
    report(diagnostics, 'schema/invalid-value', `Field "src" ${srcError}.`, [...path, 'src']);
    return undefined;
  }
  return { src, mode };
}

/** Reads an optional `properties` map of scalars, resource references and explicit nulls (#6). */
export function readProperties(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): Record<string, PropertyValue> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "properties" must be an object.', path);
    return undefined;
  }
  const properties: Record<string, PropertyValue> = Object.create(null);
  let failed = false;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0) {
      report(diagnostics, 'schema/invalid-value', 'Property keys must not be empty.', path);
      failed = true;
      continue;
    }
    const entryPath = [...path, key];
    if (typeof entry === 'string' || typeof entry === 'boolean') {
      properties[key] = entry;
      continue;
    }
    if (entry === null) {
      properties[key] = null;
      continue;
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        report(
          diagnostics,
          'schema/invalid-value',
          `Property "${key}" must be a finite number.`,
          entryPath,
        );
        failed = true;
        continue;
      }
      properties[key] = entry;
      continue;
    }
    if (typeof entry === 'object' && !Array.isArray(entry)) {
      const reference = readAssetReference(entry, entryPath, diagnostics);
      if (reference === undefined) {
        failed = true;
        continue;
      }
      properties[key] = reference;
      continue;
    }
    report(
      diagnostics,
      'schema/invalid-value',
      `Property "${key}" must be a string, finite number, boolean, resource reference or null.`,
      entryPath,
    );
    failed = true;
  }
  return failed ? undefined : properties;
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
