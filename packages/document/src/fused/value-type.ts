/**
 * Public payload types of a device model (RFC 0021): declaration reading, reference checking and
 * value validation.
 */
import { FusedDocumentError } from './diagnostics';
import type { FusedDiagnostic } from './diagnostics';
import { isMemberKey } from './rules';
import type { ValueType } from './types/model';
import {
  forbidUnknownFields,
  hasErrors,
  hasOwn,
  isRecord,
  readArrayField,
  readObjectField,
  readStringField,
  report,
  toPointer,
} from './read';

const SIMPLE_TYPES = ['null', 'boolean', 'number', 'string', 'binary'] as const;

type SimpleType = (typeof SIMPLE_TYPES)[number];

export interface DeclaredTypes {
  readonly types: Readonly<Record<string, ValueType>> | undefined;
  /** Declared names, known even when one declaration failed to parse. */
  readonly names: ReadonlySet<string>;
}

/**
 * Reads the `types` map of a model declaration.
 *
 * Names are collected first so a `ref` can address a type declared later in the same map.
 */
export function readTypeDeclarations(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): DeclaredTypes {
  const names = new Set<string>();
  for (const key of Object.keys(value)) {
    if (!isMemberKey(key)) {
      report(
        diagnostics,
        'model/invalid-interface',
        `Public type name ${JSON.stringify(key)} must match [A-Za-z][A-Za-z0-9]*.`,
        [...path, key],
      );
      continue;
    }
    names.add(key);
  }

  const types: Record<string, ValueType> = Object.create(null) as Record<string, ValueType>;
  let failed = false;
  for (const [key, raw] of Object.entries(value)) {
    if (!names.has(key)) {
      continue;
    }
    const type = readValueType(raw, [...path, key], diagnostics, names);
    if (type === undefined) {
      failed = true;
      continue;
    }
    types[key] = type;
  }

  if (!failed) {
    checkReferenceChains(types, path, diagnostics);
  }
  return { types, names };
}

/** Reads one value type declaration, rejecting unknown members and unknown `ref` targets. */
export function readValueType(
  value: unknown,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  declared: ReadonlySet<string>,
): ValueType | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Value type must be an object.', path);
    return undefined;
  }
  const hasRef = hasOwn(value, 'ref');
  const hasType = hasOwn(value, 'type');
  if (hasRef && hasType) {
    report(
      diagnostics,
      'schema/invalid-value',
      'Value type must declare either "ref" or "type", not both.',
      path,
    );
    return undefined;
  }
  if (hasRef) {
    forbidUnknownFields(value, ['ref'], path, diagnostics);
    const ref = readStringField(value, 'ref', path, diagnostics, true, { nonEmpty: true });
    if (ref === undefined) {
      return undefined;
    }
    if (!declared.has(ref)) {
      report(diagnostics, 'type/unknown', `Unknown public type "${ref}".`, [...path, 'ref']);
      return undefined;
    }
    return { ref };
  }
  if (!hasType) {
    report(diagnostics, 'schema/missing-field', 'Value type must declare "type" or "ref".', [
      ...path,
      'type',
    ]);
    return undefined;
  }

  const type = readStringField(value, 'type', path, diagnostics, true, { nonEmpty: true });
  if (type === undefined) {
    return undefined;
  }
  if ((SIMPLE_TYPES as readonly string[]).includes(type)) {
    forbidUnknownFields(value, ['type'], path, diagnostics);
    return { type: type as SimpleType };
  }

  switch (type) {
    case 'array': {
      forbidUnknownFields(value, ['type', 'items'], path, diagnostics);
      const itemsPath = [...path, 'items'];
      if (!hasOwn(value, 'items')) {
        report(diagnostics, 'schema/missing-field', 'Missing required field "items".', itemsPath);
        return undefined;
      }
      const items = readValueType(value['items'], itemsPath, diagnostics, declared);
      return items === undefined ? undefined : { type: 'array', items };
    }
    case 'object': {
      forbidUnknownFields(
        value,
        ['type', 'properties', 'optional', 'additionalProperties'],
        path,
        diagnostics,
      );
      const propertiesField = readObjectField(value, 'properties', path, diagnostics);
      if (propertiesField === undefined) {
        return undefined;
      }
      const properties: Record<string, ValueType> = Object.create(null) as Record<
        string,
        ValueType
      >;
      let failed = false;
      for (const [key, raw] of Object.entries(propertiesField)) {
        if (!isMemberKey(key)) {
          report(
            diagnostics,
            'model/invalid-interface',
            `Property name ${JSON.stringify(key)} must match [A-Za-z][A-Za-z0-9]*.`,
            [...path, 'properties', key],
          );
          failed = true;
          continue;
        }
        const propertyType = readValueType(
          raw,
          [...path, 'properties', key],
          diagnostics,
          declared,
        );
        if (propertyType === undefined) {
          failed = true;
          continue;
        }
        properties[key] = propertyType;
      }

      const optional: string[] = [];
      const rawOptional = readArrayField(value, 'optional', path, diagnostics, false);
      if (rawOptional !== undefined) {
        const seen = new Set<string>();
        rawOptional.forEach((entry, index) => {
          const entryPath = [...path, 'optional', String(index)];
          if (typeof entry !== 'string' || entry.length === 0) {
            report(
              diagnostics,
              'schema/invalid-type',
              'Optional property names must be non-empty strings.',
              entryPath,
            );
            failed = true;
            return;
          }
          if (seen.has(entry)) {
            report(
              diagnostics,
              'schema/invalid-value',
              `Optional property "${entry}" is listed more than once.`,
              entryPath,
            );
            failed = true;
            return;
          }
          seen.add(entry);
          if (!hasOwn(propertiesField, entry)) {
            report(
              diagnostics,
              'model/invalid-interface',
              `Optional property "${entry}" is not declared in "properties".`,
              entryPath,
            );
            failed = true;
            return;
          }
          optional.push(entry);
        });
      }

      let additionalProperties: ValueType | undefined;
      if (hasOwn(value, 'additionalProperties')) {
        additionalProperties = readValueType(
          value['additionalProperties'],
          [...path, 'additionalProperties'],
          diagnostics,
          declared,
        );
        if (additionalProperties === undefined) {
          failed = true;
        }
      }

      if (failed) {
        return undefined;
      }
      return {
        type: 'object',
        properties,
        ...(rawOptional === undefined ? {} : { optional }),
        ...(additionalProperties === undefined ? {} : { additionalProperties }),
      };
    }
    default:
      report(
        diagnostics,
        'model/invalid-interface',
        `Unknown value type ${JSON.stringify(type)}.`,
        [...path, 'type'],
      );
      return undefined;
  }
}

/**
 * Rejects `ref` chains that never reach a concrete type, e.g. `A -> B -> A`.
 *
 * Recursion through object or array members is legal and is not reported here.
 */
function checkReferenceChains(
  types: Readonly<Record<string, ValueType>>,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
): void {
  for (const name of Object.keys(types)) {
    const chain: string[] = [];
    let current = types[name];
    while (current !== undefined && !('type' in current)) {
      const next = current.ref;
      if (next === name || chain.includes(next)) {
        report(
          diagnostics,
          'model/invalid-interface',
          `Public type "${name}" resolves through a cycle of "ref" declarations.`,
          [...path, name],
        );
        break;
      }
      chain.push(next);
      current = types[next];
    }
  }
}

/**
 * Validates one model value against its declared type (RFC 0021).
 *
 * @throws {FusedDocumentError} with the diagnostic code and JSON Pointer of every violation.
 */
export function validateModelValue(
  value: unknown,
  type: ValueType,
  types: Readonly<Record<string, ValueType>> = {},
): void {
  const diagnostics: FusedDiagnostic[] = [];
  checkValue(value, type, [], diagnostics, types);
  if (hasErrors(diagnostics)) {
    throw new FusedDocumentError(diagnostics);
  }
}

function checkValue(
  value: unknown,
  type: ValueType,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  types: Readonly<Record<string, ValueType>>,
): void {
  const resolved = resolveValueType(type, path, diagnostics, types);
  if (resolved === undefined) {
    return;
  }
  switch (resolved.type) {
    case 'null':
      if (value !== null) {
        mismatch(diagnostics, 'null', path);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        mismatch(diagnostics, 'a boolean', path);
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        mismatch(diagnostics, 'a finite number', path);
      }
      return;
    case 'string':
      if (typeof value !== 'string') {
        mismatch(diagnostics, 'a string', path);
      }
      return;
    case 'binary':
      if (!(value instanceof Uint8Array)) {
        mismatch(diagnostics, 'a Uint8Array', path);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        mismatch(diagnostics, 'an array', path);
        return;
      }
      value.forEach((item, index) => {
        checkValue(item, resolved.items, [...path, String(index)], diagnostics, types);
      });
      return;
    case 'object': {
      if (!isPlainValueObject(value)) {
        mismatch(diagnostics, 'an object', path);
        return;
      }
      const optional = resolved.optional ?? [];
      for (const [key, propertyType] of Object.entries(resolved.properties)) {
        if (!hasOwn(value, key)) {
          if (!optional.includes(key)) {
            report(diagnostics, 'schema/invalid-value', `Missing required property "${key}".`, [
              ...path,
              key,
            ]);
          }
          continue;
        }
        checkValue(value[key], propertyType, [...path, key], diagnostics, types);
      }
      const additional = resolved.additionalProperties;
      for (const key of Object.keys(value)) {
        if (hasOwn(resolved.properties, key)) {
          continue;
        }
        if (additional === undefined) {
          report(diagnostics, 'schema/invalid-value', `Unexpected property "${key}".`, [
            ...path,
            key,
          ]);
          continue;
        }
        checkValue(value[key], additional, [...path, key], diagnostics, types);
      }
      return;
    }
  }
}

/** Follows a chain of `ref` declarations to the concrete type it names. */
function resolveValueType(
  type: ValueType,
  path: readonly string[],
  diagnostics: FusedDiagnostic[],
  types: Readonly<Record<string, ValueType>>,
): Exclude<ValueType, { readonly ref: string }> | undefined {
  const chain: string[] = [];
  let current: ValueType = type;
  while ('ref' in current) {
    const name = current.ref;
    if (chain.includes(name)) {
      report(
        diagnostics,
        'model/invalid-interface',
        `Public type "${name}" resolves through a cycle of "ref" declarations.`,
        path,
      );
      return undefined;
    }
    chain.push(name);
    const next = types[name];
    if (next === undefined) {
      report(diagnostics, 'type/unknown', `Unknown public type "${name}".`, path);
      return undefined;
    }
    current = next;
  }
  return current;
}

function mismatch(diagnostics: FusedDiagnostic[], expected: string, path: readonly string[]): void {
  report(diagnostics, 'schema/invalid-value', `Value must be ${expected}.`, path);
}

/** `Value` objects are plain data: no arrays, no bytes, no class instances. */
function isPlainValueObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (value instanceof Uint8Array) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Pointer of a value path, for hosts that report model value problems. */
export function valuePointer(path: readonly string[]): string {
  return toPointer(path);
}
