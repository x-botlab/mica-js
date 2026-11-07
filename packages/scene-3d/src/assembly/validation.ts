/**
 * Structural validation for `.assembly.json` payloads.
 *
 * {@link validateAssemblyDefinition} accepts the value produced by `JSON.parse` and reports every
 * problem it finds instead of throwing. It deliberately performs no semantic checks that need the
 * referenced schematic: paths, symbol names and ports are verified by the loader that owns the
 * schematic registry, not by the format itself.
 */

import { ENTITY_TYPES } from '../entities';
import { ASSEMBLY_VERSION } from './types';

/** Diagnostic codes emitted by {@link validateAssemblyDefinition}. */
export type AssemblyDiagnosticCode =
  | 'assembly/invalid-root'
  | 'assembly/unsupported-version'
  | 'assembly/invalid-field'
  | 'assembly/invalid-entity'
  | 'assembly/duplicate-entity-id'
  | 'assembly/invalid-binding';

/** A single problem found in an assembly definition. */
export interface AssemblyDiagnostic {
  readonly code: AssemblyDiagnosticCode;
  readonly message: string;
  /** Path to the offending value, starting at the document root. */
  readonly path: readonly string[];
}

/** Outcome of {@link validateAssemblyDefinition}. */
export interface AssemblyValidationResult {
  /** `true` when the value satisfies the `.assembly.json` contract. */
  readonly ok: boolean;
  /** Every problem found, in document order; empty when {@link ok} is `true`. */
  readonly diagnostics: readonly AssemblyDiagnostic[];
}

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);
const METADATA_STRING_FIELDS = ['author', 'description', 'thumbnail'] as const;

/**
 * Validates an unknown value as an {@link AssemblyDefinition}.
 *
 * The check covers the root fields, the shape of every entity (identity, pose and optional topic
 * bindings), `centerOfMass` and `metadata`. Unknown fields are ignored so a document written for a
 * newer minor revision of the format still loads.
 */
export function validateAssemblyDefinition(value: unknown): AssemblyValidationResult {
  const diagnostics: AssemblyDiagnostic[] = [];
  validateRoot(value, diagnostics);
  return { ok: diagnostics.length === 0, diagnostics };
}

function validateRoot(value: unknown, diagnostics: AssemblyDiagnostic[]): void {
  if (!isRecord(value)) {
    report(diagnostics, 'assembly/invalid-root', 'Assembly definition must be a JSON object.', []);
    return;
  }

  if (value.version !== ASSEMBLY_VERSION) {
    report(
      diagnostics,
      'assembly/unsupported-version',
      `Unsupported assembly version ${describe(value.version)}; expected ${ASSEMBLY_VERSION}.`,
      ['version'],
    );
  }
  validateRequiredString(value.name, ['name'], diagnostics);
  validateOptionalString(value.displayName, ['displayName'], diagnostics);
  validateRequiredString(value.schematic, ['schematic'], diagnostics);
  validateEntities(value.entities, diagnostics);
  validateOptionalVec3(value.centerOfMass, ['centerOfMass'], diagnostics);
  validateMetadata(value.metadata, diagnostics);
}

function validateEntities(value: unknown, diagnostics: AssemblyDiagnostic[]): void {
  if (value === undefined) {
    report(diagnostics, 'assembly/invalid-field', 'Missing required field "entities".', [
      'entities',
    ]);
    return;
  }
  if (!Array.isArray(value)) {
    report(diagnostics, 'assembly/invalid-field', '"entities" must be an array.', ['entities']);
    return;
  }

  const ids = new Set<string>();
  value.forEach((entity, index) => {
    validateEntity(entity, index, ids, diagnostics);
  });
}

function validateEntity(
  value: unknown,
  index: number,
  ids: Set<string>,
  diagnostics: AssemblyDiagnostic[],
): void {
  const path = ['entities', String(index)];
  if (!isRecord(value)) {
    report(diagnostics, 'assembly/invalid-entity', 'Each entity must be a JSON object.', path);
    return;
  }

  if (typeof value.id !== 'string' || value.id.trim() === '') {
    report(diagnostics, 'assembly/invalid-entity', 'Entity "id" must be a non-empty string.', [
      ...path,
      'id',
    ]);
  } else if (ids.has(value.id)) {
    report(diagnostics, 'assembly/duplicate-entity-id', `Duplicate entity id "${value.id}".`, [
      ...path,
      'id',
    ]);
  } else {
    ids.add(value.id);
  }

  if (typeof value.type !== 'string' || !ENTITY_TYPE_SET.has(value.type)) {
    report(
      diagnostics,
      'assembly/invalid-entity',
      `Entity "type" must be one of: ${ENTITY_TYPES.join(', ')}.`,
      [...path, 'type'],
    );
  }

  validateVec3(value.position, [...path, 'position'], diagnostics);
  validateQuaternion(value.rotation, [...path, 'rotation'], diagnostics);
  validateOptionalString(value.name, [...path, 'name'], diagnostics);
  switch (value.type) {
    case 'assembly':
      validateRequiredString(value.assembly, [...path, 'assembly'], diagnostics);
      break;
    case 'joint':
    case 'sensor':
      validateBindings(value.bindings, [...path, 'bindings'], diagnostics);
      break;
    default:
      break;
  }
}

function validateMetadata(value: unknown, diagnostics: AssemblyDiagnostic[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    report(diagnostics, 'assembly/invalid-field', '"metadata" must be an object.', ['metadata']);
    return;
  }

  for (const field of METADATA_STRING_FIELDS) {
    validateOptionalString(value[field], ['metadata', field], diagnostics);
  }

  const tags = value.tags;
  if (tags === undefined) {
    return;
  }
  if (!Array.isArray(tags)) {
    report(diagnostics, 'assembly/invalid-field', '"tags" must be an array of strings.', [
      'metadata',
      'tags',
    ]);
    return;
  }
  tags.forEach((tag, index) => {
    validateString(tag, ['metadata', 'tags', String(index)], diagnostics);
  });
}

function validateBindings(
  value: unknown,
  path: readonly string[],
  diagnostics: AssemblyDiagnostic[],
): void {
  if (value === undefined) {
    return;
  }
  const label = fieldName(path);
  if (!isRecord(value)) {
    report(
      diagnostics,
      'assembly/invalid-binding',
      `"${label}" must be an object mapping port keys to binding targets.`,
      path,
    );
    return;
  }
  for (const [portKey, binding] of Object.entries(value)) {
    const bindingPath = [...path, portKey];
    if (!isRecord(binding)) {
      report(
        diagnostics,
        'assembly/invalid-binding',
        `"${label}.${portKey}" must be an object with "symbol" and "port".`,
        bindingPath,
      );
      continue;
    }
    if (typeof binding.symbol !== 'string' || binding.symbol.trim() === '') {
      report(
        diagnostics,
        'assembly/invalid-binding',
        `"${label}.${portKey}.symbol" must be a non-empty string.`,
        [...bindingPath, 'symbol'],
      );
    }
    if (typeof binding.port !== 'string' || binding.port.trim() === '') {
      report(
        diagnostics,
        'assembly/invalid-binding',
        `"${label}.${portKey}.port" must be a non-empty string.`,
        [...bindingPath, 'port'],
      );
    }
  }
}

function validateOptionalVec3(
  value: unknown,
  path: readonly string[],
  diagnostics: AssemblyDiagnostic[],
): void {
  if (value !== undefined) {
    validateVec3(value, path, diagnostics);
  }
}

function validateVec3(
  value: unknown,
  path: readonly string[],
  diagnostics: AssemblyDiagnostic[],
): void {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.z)
  ) {
    report(
      diagnostics,
      'assembly/invalid-field',
      `"${fieldName(path)}" must be an object with finite x, y and z numbers.`,
      path,
    );
  }
}

function validateQuaternion(
  value: unknown,
  path: readonly string[],
  diagnostics: AssemblyDiagnostic[],
): void {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.z) ||
    !isFiniteNumber(value.w)
  ) {
    report(
      diagnostics,
      'assembly/invalid-field',
      `"${fieldName(path)}" must be an object with finite x, y, z and w numbers.`,
      path,
    );
  }
}

function validateRequiredString(
  value: unknown,
  path: readonly string[],
  diagnostics: AssemblyDiagnostic[],
): void {
  if (value === undefined) {
    report(
      diagnostics,
      'assembly/invalid-field',
      `Missing required field "${fieldName(path)}".`,
      path,
    );
    return;
  }
  validateString(value, path, diagnostics);
}

function validateOptionalString(
  value: unknown,
  path: readonly string[],
  diagnostics: AssemblyDiagnostic[],
): void {
  if (value !== undefined) {
    validateString(value, path, diagnostics);
  }
}

function validateString(
  value: unknown,
  path: readonly string[],
  diagnostics: AssemblyDiagnostic[],
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    report(
      diagnostics,
      'assembly/invalid-field',
      `"${fieldName(path)}" must be a non-empty string.`,
      path,
    );
  }
}

function report(
  diagnostics: AssemblyDiagnostic[],
  code: AssemblyDiagnosticCode,
  message: string,
  path: readonly string[],
): void {
  diagnostics.push({ code, message, path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fieldName(path: readonly string[]): string {
  return path[path.length - 1] ?? 'value';
}

function describe(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return typeof value;
}
