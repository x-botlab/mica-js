import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { deviceMetadataSchema, widgetMetadataSchema } from './schema.js';
import type { MetadataKind } from './types.js';

/** One validation problem, addressed by a dot path such as `properties.led.type`. */
export interface MetadataIssue {
  /** Path of the offending value; `''` addresses the metadata root. */
  readonly path: string;
  readonly message: string;
  /** JSON Schema keyword, or `expectedId` for the cross-file id check. */
  readonly keyword: string;
}

/** Thrown by {@link validateMetadata} when a metadata document is rejected. */
export class MetadataValidationError extends Error {
  readonly kind: MetadataKind;
  readonly issues: readonly MetadataIssue[];
  readonly metadataId: string | undefined;

  constructor(
    kind: MetadataKind,
    issues: readonly MetadataIssue[],
    metadataId: string | undefined,
  ) {
    super(formatMessage(kind, issues, metadataId));
    this.name = 'MetadataValidationError';
    this.kind = kind;
    this.issues = issues;
    this.metadataId = metadataId;
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  validateFormats: false,
});

const validators: Readonly<Record<MetadataKind, ValidateFunction>> = {
  device: ajv.compile(deviceMetadataSchema),
  widget: ajv.compile(widgetMetadataSchema),
};

/** Keywords whose failure only restates a problem reported by their subschemas. */
const containerKeywords: ReadonlySet<string> = new Set(['if', 'allOf', 'anyOf', 'oneOf']);

/**
 * Validates one device or widget metadata document.
 *
 * @param input Untrusted JSON value of the metadata file.
 * @param kind Metadata kind that selects the contract.
 * @param expectedId Id the caller expects; a mismatch is reported at `id`.
 * @throws {MetadataValidationError} with the path of every rejected value.
 */
export function validateMetadata(input: unknown, kind: MetadataKind, expectedId?: string): void {
  if (kind !== 'device' && kind !== 'widget') {
    throw new TypeError(`Unknown metadata kind "${String(kind)}"; expected "device" or "widget".`);
  }

  const metadataId = isRecord(input) && typeof input.id === 'string' ? input.id : undefined;
  const fatal = findNonFiniteNumbers(input);
  if (fatal.length > 0) throw new MetadataValidationError(kind, fatal, metadataId);

  const validate = validators[kind];
  const issues: MetadataIssue[] = [];
  if (!validate(input)) issues.push(...toIssues(validate.errors ?? [], input));
  issues.push(...semanticIssues(input));
  if (expectedId !== undefined && metadataId !== undefined && metadataId !== expectedId) {
    issues.push({
      path: 'id',
      keyword: 'expectedId',
      message: `must equal the expected metadata id ${quote(expectedId)}`,
    });
  }
  if (issues.length === 0) return;
  throw new MetadataValidationError(kind, dedupeAndSort(issues), metadataId);
}

function toIssues(errors: readonly ErrorObject[], input: unknown): MetadataIssue[] {
  const issues: MetadataIssue[] = [];
  for (const error of errors) {
    if (containerKeywords.has(error.keyword)) continue;
    const params = error.params as Record<string, unknown>;
    const basePath = pointerToPath(error.instancePath);
    let path = basePath;
    if (error.keyword === 'required') path = joinPath(basePath, String(params.missingProperty));
    else if (error.keyword === 'additionalProperties') {
      path = joinPath(basePath, String(params.additionalProperty));
    }
    issues.push({ path, message: describeError(error, input), keyword: error.keyword });
  }
  if (issues.length > 0 || errors.length === 0) return issues;
  return errors.map((error) => ({
    path: pointerToPath(error.instancePath),
    message: error.message ?? 'is invalid',
    keyword: error.keyword,
  }));
}

function describeError(error: ErrorObject, input: unknown): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required': {
      const missing = String(params.missingProperty);
      const owner = resolvePointer(input, error.instancePath);
      if (missing === 'nullable' && isRecord(owner) && owner.default === null) {
        return 'must be true when the default value is null';
      }
      return `missing required field ${quote(missing)}`;
    }
    case 'additionalProperties':
      return `unknown field ${quote(String(params.additionalProperty))}`;
    case 'enum': {
      const allowed = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      return `must be one of ${allowed.map((value) => quote(String(value))).join(', ')}`;
    }
    case 'const': {
      const { parent, key } = resolveParent(input, error.instancePath);
      if (key === 'nullable' && isRecord(parent) && parent.default === null) {
        return 'must be true when the default value is null';
      }
      return `must be ${quote(String(params.allowedValue))}`;
    }
    case 'type':
      return `must be ${describeTypes(params.type)}`;
    case 'pattern':
      return `must match the pattern ${String(params.pattern)}`;
    case 'minLength':
      return params.limit === 1
        ? 'must not be empty'
        : `must have at least ${describeLimit(params)} characters`;
    case 'maxLength':
      return `must have at most ${describeLimit(params)} characters`;
    case 'minimum':
      return `must be greater than or equal to ${describeLimit(params)}`;
    case 'maximum':
      return `must be less than or equal to ${describeLimit(params)}`;
    case 'exclusiveMinimum':
      return `must be greater than ${describeLimit(params)}`;
    case 'exclusiveMaximum':
      return `must be less than ${describeLimit(params)}`;
    case 'uniqueItems':
      return 'must not contain duplicate values';
    case 'minItems':
      return `must contain at least ${describeLimit(params)} items`;
    case 'maxItems':
      return `must contain at most ${describeLimit(params)} items`;
    case 'false schema':
      return describeForbiddenField(input, error.instancePath);
    case 'not':
      return `must not be ${formatValue(resolvePointer(input, error.instancePath))}`;
    default:
      return error.message ?? 'is invalid';
  }
}

function describeForbiddenField(input: unknown, pointer: string): string {
  const { parent, key } = resolveParent(input, pointer);
  if (key === 'default' && isRecord(parent)) {
    if (parent.type === 'bytes') {
      return 'must not be declared: bytes properties cannot declare defaults';
    }
    if (parent.required === true) return 'must not be declared when "required" is true';
  }
  if ((key === 'enumName' || key === 'values') && isRecord(parent) && parent.type !== 'enum') {
    return 'must not be declared unless "type" is "enum"';
  }
  return 'must not be declared';
}

function describeTypes(type: unknown): string {
  const names = (Array.isArray(type) ? type : [type]).map((name) => String(name));
  if (names.length <= 1) return names[0] ?? 'of the expected type';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'the forbidden value';
  return JSON.stringify(value) ?? String(value);
}

function describeLimit(params: Record<string, unknown>): string {
  return JSON.stringify(params.limit);
}

/** Checks that JSON Schema cannot express without duplicating every enum. */
function semanticIssues(input: unknown): MetadataIssue[] {
  if (!isRecord(input)) return [];
  const issues: MetadataIssue[] = [];
  const properties = input.properties;
  if (!isRecord(properties)) return issues;
  for (const [key, entry] of Object.entries(properties)) {
    if (!isRecord(entry)) continue;
    const path = `properties.${key}`;
    if (entry.type === 'enum' && Array.isArray(entry.values) && 'default' in entry) {
      const value = entry.default;
      const values = entry.values.filter((item): item is string => typeof item === 'string');
      if (typeof value === 'string' && !values.includes(value)) {
        issues.push({
          path: `${path}.default`,
          keyword: 'default',
          message: `must be one of the declared "values" (${values.map(quote).join(', ')})`,
        });
      }
    }
    const editor = entry.editor;
    if (isRecord(editor) && editor.kind === 'number') {
      const { min, max } = editor;
      if (typeof min === 'number' && typeof max === 'number' && min > max) {
        issues.push({
          path: `${path}.editor`,
          keyword: 'editor',
          message: '"min" must be less than or equal to "max"',
        });
      }
    }
  }
  return issues;
}

/** NaN and Infinity are not JSON numbers, so they are rejected before schema validation. */
function findNonFiniteNumbers(
  value: unknown,
  path = '',
  found: MetadataIssue[] = [],
): MetadataIssue[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      found.push({ path, keyword: 'number', message: 'must be a finite JSON number' });
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findNonFiniteNumbers(item, joinPath(path, String(index)), found),
    );
    return found;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      findNonFiniteNumbers(item, joinPath(path, key), found);
    }
  }
  return found;
}

function dedupeAndSort(issues: readonly MetadataIssue[]): MetadataIssue[] {
  const unique = new Map<string, MetadataIssue>();
  for (const issue of issues) {
    const key = `${issue.path}\u0000${issue.message}`;
    if (!unique.has(key)) unique.set(key, issue);
  }
  return [...unique.values()].sort((left, right) =>
    left.path === right.path
      ? left.message.localeCompare(right.message)
      : left.path.localeCompare(right.path),
  );
}

function formatMessage(
  kind: MetadataKind,
  issues: readonly MetadataIssue[],
  metadataId: string | undefined,
): string {
  const subject =
    metadataId === undefined ? `${kind} metadata` : `${kind} metadata ${quote(metadataId)}`;
  const count = `${issues.length} ${issues.length === 1 ? 'problem' : 'problems'}`;
  const lines = issues.map(
    (issue) => `  - ${issue.path === '' ? '<root>' : issue.path}: ${issue.message}`,
  );
  return [`Invalid ${subject} (${count}):`, ...lines].join('\n');
}

function pointerToPath(pointer: string): string {
  if (pointer === '') return '';
  return pointer.slice(1).split('/').map(decodeSegment).join('.');
}

function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function joinPath(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

function resolvePointer(input: unknown, pointer: string): unknown {
  if (pointer === '') return input;
  let current = input;
  for (const segment of pointer.slice(1).split('/').map(decodeSegment)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolveParent(input: unknown, pointer: string): { parent: unknown; key: string } {
  const index = pointer.lastIndexOf('/');
  if (index < 0) return { parent: input, key: '' };
  return {
    parent: resolvePointer(input, pointer.slice(0, index)),
    key: decodeSegment(pointer.slice(index + 1)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
