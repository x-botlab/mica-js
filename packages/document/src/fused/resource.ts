/**
 * Persistent property values of an instance: scalars, resource references and firmware references
 * (RFC 0024 with the RFC 0020 / RFC 0026 extensions).
 */
import type { FusedDiagnostic } from './diagnostics';
import type {
  FirmwareFileReference,
  FirmwareProjectReference,
  FirmwareReference,
  PropertyValue,
  ResourceMode,
  ResourceReference,
} from './types/property';
import { packagePathProblem, projectPathProblem } from './rules';
import {
  forbidUnknownFields,
  hasOwn,
  isRecord,
  readIntegerField,
  readStringField,
  report,
} from './read';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const RESOURCE_MODES = ['file', 'package', 'inline', 'store'] as const;

/** Reads one instance property value; `undefined` when it does not match the contract. */
export function readPropertyValue(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): PropertyValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      report(diagnostics, 'schema/invalid-value', 'Numeric property values must be finite.', path);
      return undefined;
    }
    return value;
  }
  if (isRecord(value)) {
    return readReference(value, path, diagnostics);
  }
  report(
    diagnostics,
    'schema/invalid-type',
    'Property value must be a scalar, a resource reference, a firmware reference or null.',
    path,
  );
  return undefined;
}

function readReference(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): ResourceReference | FirmwareReference | undefined {
  const mode = readStringField(value, 'mode', path, diagnostics, true, { nonEmpty: true });
  if (mode === undefined) {
    return undefined;
  }
  if (mode === 'project') {
    return readProjectReference(value, path, diagnostics);
  }
  if (!(RESOURCE_MODES as readonly string[]).includes(mode)) {
    report(
      diagnostics,
      'schema/invalid-value',
      'Field "mode" must be "file", "package", "inline", "store" or "project".',
      [...path, 'mode'],
    );
    return undefined;
  }
  return readFileOrStoredReference(value, mode as ResourceMode, path, diagnostics);
}

function readProjectReference(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): FirmwareProjectReference | undefined {
  forbidUnknownFields(
    value,
    ['mode', 'projectId', 'addressSpace', 'loadAddress'],
    path,
    diagnostics,
  );
  const projectId = readStringField(value, 'projectId', path, diagnostics, true, {
    nonEmpty: true,
  });
  const overrides = readAddressOverrides(value, path, diagnostics);
  if (projectId === undefined || overrides === undefined) {
    return undefined;
  }
  return { mode: 'project', projectId, ...overrides };
}

function readFileOrStoredReference(
  value: Record<string, unknown>,
  mode: ResourceMode,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): ResourceReference | FirmwareFileReference | undefined {
  const firmwareOverrides = mode === 'file' || mode === 'package';
  const hasOverrides =
    firmwareOverrides && (hasOwn(value, 'addressSpace') || hasOwn(value, 'loadAddress'));
  forbidUnknownFields(
    value,
    hasOverrides ? ['src', 'mode', 'addressSpace', 'loadAddress'] : ['src', 'mode'],
    path,
    diagnostics,
  );
  const src = readStringField(value, 'src', path, diagnostics, true, { nonEmpty: true });
  if (src === undefined) {
    return undefined;
  }
  const srcProblem = resourceSrcProblem(mode, src);
  if (srcProblem !== undefined) {
    report(diagnostics, 'schema/invalid-value', `Field "src" ${srcProblem}.`, [...path, 'src']);
    return undefined;
  }
  if (!hasOverrides) {
    return { src, mode };
  }
  const overrides = readAddressOverrides(value, path, diagnostics);
  if (overrides === undefined) {
    return undefined;
  }
  return { src, mode: mode as FirmwareFileReference['mode'], ...overrides };
}

/** Reads optional `addressSpace` / `loadAddress` overrides of a firmware reference. */
function readAddressOverrides(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): { readonly addressSpace?: string; readonly loadAddress?: number } | undefined {
  const addressSpace = readStringField(value, 'addressSpace', path, diagnostics, false, {
    nonEmpty: true,
  });
  const loadAddress = readIntegerField(value, 'loadAddress', path, diagnostics, false);
  if (loadAddress !== undefined && loadAddress < 0) {
    report(
      diagnostics,
      'schema/invalid-value',
      'Field "loadAddress" must be a non-negative safe integer.',
      [...path, 'loadAddress'],
    );
    return undefined;
  }
  if (hasOwn(value, 'addressSpace') && addressSpace === undefined) {
    return undefined;
  }
  if (hasOwn(value, 'loadAddress') && loadAddress === undefined) {
    return undefined;
  }
  return {
    ...(addressSpace === undefined ? {} : { addressSpace }),
    ...(loadAddress === undefined ? {} : { loadAddress }),
  };
}

/** Payload problem of a resource `src` for its mode, or `undefined` when it is well formed. */
export function resourceSrcProblem(mode: ResourceMode, src: string): string | undefined {
  switch (mode) {
    case 'file':
      return projectPathProblem(src);
    case 'package':
      return packagePathProblem(src);
    case 'inline':
      return BASE64.test(src) ? undefined : 'must be base64 text';
    case 'store':
      return src.length === 0 ? 'must not be empty' : undefined;
  }
}
