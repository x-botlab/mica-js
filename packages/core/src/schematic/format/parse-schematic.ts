import type { Diagnostic } from './diagnostics';
import { SchematicError } from './errors';
import { parseInput } from './input';
import type {
  Point,
  SchematicDocument,
  SchematicJunction,
  SchematicSheet,
  SchematicSymbol,
  SchematicWire,
} from './types';
import { SCHEMATIC_VERSION } from './types';
import {
  checkDuplicateIds,
  forbidUnknownFields,
  hasErrors,
  isRecord,
  readArrayField,
  readIntegerField,
  readNumberField,
  readObjectField,
  readPoint,
  readProperties,
  readStringField,
  report,
  type IdentifiedEntry,
} from './validate';

/** @throws {SchematicError} when the input does not match the `.sch` contract. */
export function parseSchematic(input: string | unknown): SchematicDocument {
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

function readDocument(value: unknown, diagnostics: Diagnostic[]): SchematicDocument | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'json/not-object', 'Schematic must be a JSON object.', []);
    return undefined;
  }
  forbidUnknownFields(value, ['version', 'id', 'sheet'], [], diagnostics);
  const version = readVersion(value, diagnostics);
  const id = readStringField(value, 'id', [], diagnostics, { nonEmpty: true });
  const sheet = readSheet(readObjectField(value, 'sheet', [], diagnostics), diagnostics);
  if (version === undefined || id === undefined || sheet === undefined) {
    return undefined;
  }
  return { version, id, sheet };
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

function readSheet(
  value: Record<string, unknown> | undefined,
  diagnostics: Diagnostic[],
): SchematicSheet | undefined {
  if (value === undefined) {
    return undefined;
  }
  forbidUnknownFields(value, ['symbols', 'wires', 'junctions'], ['sheet'], diagnostics);
  const rawSymbols = readArrayField(value, 'symbols', ['sheet'], diagnostics) ?? [];
  const rawWires = readArrayField(value, 'wires', ['sheet'], diagnostics) ?? [];
  const rawJunctions = readArrayField(value, 'junctions', ['sheet'], diagnostics) ?? [];

  const symbols: SchematicSymbol[] = [];
  const symbolIds: IdentifiedEntry[] = [];
  rawSymbols.forEach((item, index) => {
    const path = ['sheet', 'symbols', String(index)];
    const symbol = readSymbol(item, path, diagnostics);
    if (symbol !== undefined) {
      symbols.push(symbol);
      symbolIds.push({ id: symbol.id, path: [...path, 'id'] });
    }
  });

  const wires: SchematicWire[] = [];
  const wireIds: IdentifiedEntry[] = [];
  rawWires.forEach((item, index) => {
    const path = ['sheet', 'wires', String(index)];
    const wire = readWire(item, path, diagnostics);
    if (wire !== undefined) {
      wires.push(wire);
      wireIds.push({ id: wire.id, path: [...path, 'id'] });
    }
  });

  const knownWireIds = new Set(wires.map((wire) => wire.id));
  const junctions: SchematicJunction[] = [];
  const junctionIds: IdentifiedEntry[] = [];
  rawJunctions.forEach((item, index) => {
    const path = ['sheet', 'junctions', String(index)];
    const junction = readJunction(item, path, diagnostics);
    if (junction === undefined) {
      return;
    }
    const seenWireIds = new Set<string>();
    junction.wires.forEach((wireId, wireIndex) => {
      const wirePath = [...path, 'wires', String(wireIndex)];
      if (seenWireIds.has(wireId)) {
        report(
          diagnostics,
          'junction/duplicate-wire',
          `Junction "${junction.id}" references wire "${wireId}" more than once.`,
          wirePath,
          { kind: 'junction', id: junction.id },
        );
      } else {
        seenWireIds.add(wireId);
      }
      if (!knownWireIds.has(wireId)) {
        report(
          diagnostics,
          'junction/unknown-wire',
          `Junction "${junction.id}" references unknown wire "${wireId}".`,
          wirePath,
          { kind: 'junction', id: junction.id },
        );
      }
    });
    junctions.push(junction);
    junctionIds.push({ id: junction.id, path: [...path, 'id'] });
  });

  checkDuplicateIds(symbolIds, 'symbol', diagnostics);
  checkDuplicateIds(wireIds, 'wire', diagnostics);
  checkDuplicateIds(junctionIds, 'junction', diagnostics);

  return { symbols, wires, junctions };
}

function readSymbol(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): SchematicSymbol | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Symbol must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(
    value,
    ['id', 'device', 'x', 'y', 'rotation', 'properties'],
    path,
    diagnostics,
  );
  const id = readStringField(value, 'id', path, diagnostics, { nonEmpty: true });
  const device = readStringField(value, 'device', path, diagnostics, { nonEmpty: true });
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  const rotation = readNumberField(value, 'rotation', path, diagnostics);
  const properties =
    value['properties'] === undefined
      ? undefined
      : readProperties(value['properties'], [...path, 'properties'], diagnostics);
  if (
    id === undefined ||
    device === undefined ||
    x === undefined ||
    y === undefined ||
    rotation === undefined
  ) {
    return undefined;
  }
  return properties === undefined
    ? { id, device, x, y, rotation }
    : { id, device, x, y, rotation, properties };
}

function readWire(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): SchematicWire | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Wire must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['id', 'points'], path, diagnostics);
  const id = readStringField(value, 'id', path, diagnostics, { nonEmpty: true });
  const rawPoints = readArrayField(value, 'points', path, diagnostics);
  const points: Point[] = [];
  if (rawPoints !== undefined) {
    if (rawPoints.length < 2) {
      report(diagnostics, 'wire/invalid-points', 'Wire must contain at least two points.', [
        ...path,
        'points',
      ]);
    }
    rawPoints.forEach((item, index) => {
      const point = readPoint(item, [...path, 'points', String(index)], diagnostics);
      if (point !== undefined) {
        points.push(point);
      }
    });
  }
  if (id === undefined || rawPoints === undefined) {
    return undefined;
  }
  return { id, points };
}

function readJunction(
  value: unknown,
  path: readonly string[],
  diagnostics: Diagnostic[],
): SchematicJunction | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'schema/invalid-type', 'Junction must be an object.', path);
    return undefined;
  }
  forbidUnknownFields(value, ['id', 'x', 'y', 'wires'], path, diagnostics);
  const id = readStringField(value, 'id', path, diagnostics, { nonEmpty: true });
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  const rawWires = readArrayField(value, 'wires', path, diagnostics);
  const wires: string[] = [];
  if (rawWires !== undefined) {
    if (rawWires.length < 2) {
      report(diagnostics, 'schema/invalid-value', 'Junction must reference at least two wires.', [
        ...path,
        'wires',
      ]);
    }
    rawWires.forEach((item, index) => {
      const wirePath = [...path, 'wires', String(index)];
      if (typeof item !== 'string') {
        report(
          diagnostics,
          'schema/invalid-type',
          'Junction wire reference must be a string.',
          wirePath,
        );
        return;
      }
      if (item.length === 0) {
        report(
          diagnostics,
          'schema/invalid-value',
          'Junction wire reference must not be empty.',
          wirePath,
        );
        return;
      }
      wires.push(item);
    });
  }
  if (id === undefined || x === undefined || y === undefined || rawWires === undefined) {
    return undefined;
  }
  return { id, x, y, wires };
}
