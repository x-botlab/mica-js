import type { Diagnostic } from '../../format/diagnostics';
import { SchematicError } from '../../format/errors';
import { parseInput } from '../../format/input';
import { isUuidV4 } from '../../format/uuid';
import {
  forbidUnknownFields,
  hasErrors,
  isRecord,
  readArrayField,
  readIntegerField,
  readNumberField,
  readStringField,
  report,
} from '../../format/validate';
import type {
  CanvasBindingTarget,
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from './types';
import { CANVAS_VERSION } from './types';

/**
 * `"<package>:<widget>"`; `builtin` matches the package pattern, so the same expression also
 * accepts the reserved `builtin:<widget>` form (#67).
 */
const WIDGET_REFERENCE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

const WIDGET_FIELDS = [
  'id',
  'widget',
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'properties',
  'bindings',
] as const;

/** @throws {SchematicError} when the input does not match the `.cnv` contract. */
export function parseCanvas(input: string | unknown): CanvasDocument {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseInput(input, diagnostics);
  if (!parsed.ok) {
    throw new SchematicError(diagnostics);
  }
  const value = readDocument(parsed.value, diagnostics);
  if (value === undefined || hasErrors(diagnostics)) {
    throw new SchematicError(diagnostics);
  }
  return value;
}

function readDocument(value: unknown, diagnostics: Diagnostic[]): CanvasDocument | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'json/not-object', 'Canvas must be a JSON object.', []);
    return undefined;
  }
  forbidUnknownFields(value, ['version', 'schematic', 'widgets'], [], diagnostics);
  const version = readVersion(value, diagnostics);
  const schematic = readSchematic(value, diagnostics);
  const widgets = readWidgets(readArrayField(value, 'widgets', [], diagnostics), diagnostics);
  if (version === undefined || widgets === undefined) {
    return undefined;
  }
  return schematic === undefined ? { version, widgets } : { version, schematic, widgets };
}

function readVersion(
  value: Record<string, unknown>,
  diagnostics: Diagnostic[],
): typeof CANVAS_VERSION | undefined {
  const version = readIntegerField(value, 'version', [], diagnostics);
  if (version === undefined) {
    return undefined;
  }
  if (version !== CANVAS_VERSION) {
    report(
      diagnostics,
      'schema/unsupported-version',
      `Unsupported version ${version}; expected ${CANVAS_VERSION}.`,
      ['version'],
    );
    return undefined;
  }
  return CANVAS_VERSION;
}

function readSchematic(
  value: Record<string, unknown>,
  diagnostics: Diagnostic[],
): string | undefined {
  if (!hasField(value, 'schematic')) {
    return undefined;
  }
  return readStringField(value, 'schematic', [], diagnostics, { nonEmpty: true });
}

function readWidgets(
  raw: readonly unknown[] | undefined,
  diagnostics: Diagnostic[],
): CanvasWidgetInstance[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const widgets: CanvasWidgetInstance[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const path = ['widgets', String(index)];
    const widget = readWidget(item, path, diagnostics);
    if (widget === undefined) {
      return;
    }
    if (seen.has(widget.id)) {
      report(diagnostics, 'id/duplicate', `Duplicate widget id "${widget.id}".`, [...path, 'id']);
      return;
    }
    seen.add(widget.id);
    widgets.push(widget);
  });
  return widgets;
}

/**
 * @internal Shared with the canvas edit commands so added instances obey the same rules as parsed
 * ones; not re-exported from `canvas/index.ts`.
 */
export function readWidget(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): CanvasWidgetInstance | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Widget instance must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, WIDGET_FIELDS, path, diagnostics);
  const id = readId(value, path, diagnostics);
  const widget = readWidgetReference(value, path, diagnostics);
  const placement = readPlacement(value, path, diagnostics);
  const hasProperties = hasField(value, 'properties');
  const properties = hasProperties
    ? readProperties(value['properties'], [...path, 'properties'], diagnostics)
    : undefined;
  const hasBindings = hasField(value, 'bindings');
  const bindings = hasBindings
    ? readBindings(value['bindings'], [...path, 'bindings'], diagnostics)
    : undefined;
  if (
    id === undefined ||
    widget === undefined ||
    placement === undefined ||
    (hasProperties && properties === undefined) ||
    (hasBindings && bindings === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    widget,
    ...placement,
    ...(properties === undefined ? {} : { properties }),
    ...(bindings === undefined ? {} : { bindings }),
  };
}

function readId(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): string | undefined {
  const id = readStringField(value, 'id', path, diagnostics, { nonEmpty: true });
  if (id === undefined) {
    return undefined;
  }
  if (!isUuidV4(id)) {
    report(diagnostics, 'schema/invalid-value', 'Field "id" must be a UUID v4.', [...path, 'id']);
    return undefined;
  }
  return id;
}

function readWidgetReference(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): string | undefined {
  const widget = readStringField(value, 'widget', path, diagnostics, { nonEmpty: true });
  if (widget === undefined) {
    return undefined;
  }
  if (!WIDGET_REFERENCE.test(widget)) {
    report(
      diagnostics,
      'schema/invalid-value',
      'Field "widget" must be "<package>:<widget>" or "builtin:<widget>".',
      [...path, 'widget'],
    );
    return undefined;
  }
  return widget;
}

function readPlacement(
  value: Record<string, unknown>,
  path: readonly string[],
  diagnostics: Diagnostic[],
): WidgetPlacement | undefined {
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  const width = readPositiveNumber(value, 'width', path, diagnostics);
  const height = readPositiveNumber(value, 'height', path, diagnostics);
  const rotation = readNumberField(value, 'rotation', path, diagnostics);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    rotation === undefined
  ) {
    return undefined;
  }
  return { x, y, width, height, rotation };
}

/**
 * @internal Shared with the canvas edit commands so a replacement placement is validated like a
 * parsed one.
 */
export function readWidgetPlacement(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): WidgetPlacement | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Placement must be an object.', path);
    return undefined;
  }
  return readPlacement(value, path, diagnostics);
}

function readPositiveNumber(
  value: Record<string, unknown>,
  key: string,
  path: readonly string[],
  diagnostics: Diagnostic[],
): number | undefined {
  const field = readNumberField(value, key, path, diagnostics);
  if (field === undefined) {
    return undefined;
  }
  if (field <= 0) {
    report(diagnostics, 'schema/invalid-value', `Field "${key}" must be a positive number.`, [
      ...path,
      key,
    ]);
    return undefined;
  }
  return field;
}

/**
 * Property values are opaque to the format: their types come from the widget definition (#7), so
 * only the map shape and key spelling are checked here.
 */
function readProperties(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "properties" must be an object.', path);
    return undefined;
  }
  const properties: Record<string, unknown> = Object.create(null);
  let failed = false;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0) {
      report(diagnostics, 'schema/invalid-value', 'Property keys must not be empty.', path);
      failed = true;
      continue;
    }
    properties[key] = clonePropertyValue(entry);
  }
  return failed ? undefined : properties;
}

/**
 * Values are copied so the parsed document never aliases the caller's input object.
 *
 * @internal Shared with the canvas edit commands so a written property value has the same
 * ownership semantics as a parsed one; not re-exported from `canvas/index.ts`.
 */
export function clonePropertyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(clonePropertyValue);
  }
  const prototype = isRecord(value) ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      clonePropertyValue(entry),
    ]),
  );
}

function readBindings(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): Record<string, CanvasBindingTarget> | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Field "bindings" must be an object.', path);
    return undefined;
  }
  const bindings: Record<string, CanvasBindingTarget> = Object.create(null);
  let failed = false;
  for (const [port, entry] of Object.entries(value)) {
    if (port.length === 0) {
      report(diagnostics, 'schema/invalid-value', 'Binding port keys must not be empty.', path);
      failed = true;
      continue;
    }
    const target = readBindingTarget(entry, [...path, port], diagnostics);
    if (target === undefined) {
      failed = true;
      continue;
    }
    bindings[port] = target;
  }
  return failed ? undefined : bindings;
}

/** @internal Shared with the canvas edit commands for structural binding checks. */
export function readBindingTarget(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): CanvasBindingTarget | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Binding target must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['symbol', 'port'], path, diagnostics);
  const symbol = readStringField(value, 'symbol', path, diagnostics, { nonEmpty: true });
  const port = readStringField(value, 'port', path, diagnostics, { nonEmpty: true });
  if (symbol === undefined || port === undefined) {
    return undefined;
  }
  return { symbol, port };
}

function hasField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
