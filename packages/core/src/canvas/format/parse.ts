import type { Diagnostic } from '../../schematic/format/diagnostics';
import { SchematicError } from '../../schematic/format/errors';
import { parseInput } from '../../schematic/format/input';
import {
  forbidUnknownFields,
  hasErrors,
  isRecord,
  readIntegerField,
  readNumberField,
  readObjectField,
  readStringField,
  report,
} from '../../schematic/format/validate';
import type { CanvasDocument, CanvasPlacement } from './types';
import { CANVAS_VERSION } from './types';

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
  forbidUnknownFields(value, ['version', 'id', 'schematic', 'layout'], [], diagnostics);
  const version = readVersion(value, diagnostics);
  const id = readStringField(value, 'id', [], diagnostics, { nonEmpty: true });
  const schematic = readStringField(value, 'schematic', [], diagnostics, { nonEmpty: true });
  const layout = readLayout(readObjectField(value, 'layout', [], diagnostics), diagnostics);
  if (
    version === undefined ||
    id === undefined ||
    schematic === undefined ||
    layout === undefined
  ) {
    return undefined;
  }
  return { version, id, schematic, layout };
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

function readLayout(
  value: Record<string, unknown> | undefined,
  diagnostics: Diagnostic[],
): Readonly<Record<string, CanvasPlacement>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const layout: Record<string, CanvasPlacement> = Object.create(null);
  for (const symbolId of Object.keys(value)) {
    const path = ['layout', symbolId];
    if (symbolId.length === 0) {
      report(diagnostics, 'schema/invalid-value', 'Layout symbol id must not be empty.', path);
      continue;
    }
    const placement = readPlacement(value[symbolId], path, diagnostics);
    if (placement !== undefined) {
      layout[symbolId] = placement;
    }
  }
  return layout;
}

function readPlacement(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): CanvasPlacement | undefined {
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
