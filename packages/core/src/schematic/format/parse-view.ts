import type { Diagnostic } from './diagnostics';
import { SchematicError } from './errors';
import { parseInput } from './input';
import type { Placement, SchematicViewDocument } from './types';
import { SCHEMATIC_VERSION } from './types';
import {
  forbidUnknownFields,
  hasErrors,
  isRecord,
  readIntegerField,
  readObjectField,
  readPlacement,
  readStringField,
  report,
} from './validate';

/** @throws {SchematicError} when the input does not match the `.view` contract. */
export function parseView(input: string | unknown): SchematicViewDocument {
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

function readDocument(
  value: unknown,
  diagnostics: Diagnostic[],
): SchematicViewDocument | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'json/not-object', 'View must be a JSON object.', []);
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
): typeof SCHEMATIC_VERSION | undefined {
  const version = readIntegerField(value, 'version', [], diagnostics);
  if (version === undefined) {
    return undefined;
  }
  if (version !== SCHEMATIC_VERSION) {
    report(
      diagnostics,
      'schema/unsupported-version',
      `Unsupported version ${version}; expected ${SCHEMATIC_VERSION}.`,
      ['version'],
    );
    return undefined;
  }
  return SCHEMATIC_VERSION;
}

function readLayout(
  value: Record<string, unknown> | undefined,
  diagnostics: Diagnostic[],
): Readonly<Record<string, Placement>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const layout: Record<string, Placement> = Object.create(null);
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
