import type { Diagnostic } from '../../format/diagnostics';
import { SchematicError } from '../../format/errors';
import { parseInput } from '../../format/input';
import { isUuidV4 } from '../../format/uuid';
import type {
  SchematicDocument,
  SchematicJunction,
  SchematicSheet,
  SchematicSymbol,
  SchematicWire,
} from '../../format/types';
import { SCHEMATIC_VERSION } from '../../format/types';
import type { Point } from '../../format/value';
import {
  designatorOf,
  hasDesignator,
  namesNet,
  symbolRole,
  type SymbolRole,
} from '../device/reference';
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
} from '../../format/validate';

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
  forbidUnknownFields(value, ['version', 'sheet'], [], diagnostics);
  const version = readVersion(value, diagnostics);
  const sheet = readSheet(readObjectField(value, 'sheet', [], diagnostics), diagnostics);
  if (version === undefined || sheet === undefined) {
    return undefined;
  }
  return { version, sheet };
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
  checkDuplicateDesignators(symbols, diagnostics);
  checkDuplicateIds(wireIds, 'wire', diagnostics);
  checkDuplicateIds(junctionIds, 'junction', diagnostics);

  return { symbols, wires, junctions };
}

/** Two components must not share a reference designator. */
function checkDuplicateDesignators(
  symbols: readonly SchematicSymbol[],
  diagnostics: Diagnostic[],
): void {
  const seen = new Set<string>();
  symbols.forEach((symbol, index) => {
    const designator = designatorOf(symbol);
    if (designator === undefined) {
      return;
    }
    if (seen.has(designator)) {
      report(
        diagnostics,
        'symbol/designator-duplicate',
        `Reference designator ${JSON.stringify(designator)} is used more than once.`,
        ['sheet', 'symbols', String(index), 'designator'],
        { kind: 'symbol', id: symbol.id },
      );
      return;
    }
    seen.add(designator);
  });
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
    ['id', 'device', 'x', 'y', 'rotation', 'properties', 'designator', 'net', 'reference'],
    path,
    diagnostics,
  );
  const id = readId(value, path, diagnostics);
  const device = readStringField(value, 'device', path, diagnostics, { nonEmpty: true });
  const x = readNumberField(value, 'x', path, diagnostics);
  const y = readNumberField(value, 'y', path, diagnostics);
  const rotation = readNumberField(value, 'rotation', path, diagnostics);
  const properties =
    value['properties'] === undefined
      ? undefined
      : readProperties(value['properties'], [...path, 'properties'], diagnostics);
  const reference =
    value['reference'] === undefined
      ? undefined
      : readPoint(value['reference'], [...path, 'reference'], diagnostics);
  const designator = readRoleField(value, 'designator', device, path, diagnostics, hasDesignator);
  const net = readRoleField(value, 'net', device, path, diagnostics, namesNet);
  if (device !== undefined) {
    const role = symbolRole(device);
    if (namesNet(role) && net === undefined && value['net'] === undefined) {
      report(
        diagnostics,
        'symbol/missing-net',
        `Symbols of role "${role}" must name the net they attach to.`,
        [...path, 'net'],
      );
    }
    if (!hasDesignator(role) && value['reference'] !== undefined) {
      report(
        diagnostics,
        'symbol/unsupported-field',
        `Symbols of role "${role}" carry no reference designator.`,
        [...path, 'reference'],
      );
    }
  }
  if (
    id === undefined ||
    device === undefined ||
    x === undefined ||
    y === undefined ||
    rotation === undefined ||
    (value['reference'] !== undefined && reference === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    device,
    x,
    y,
    rotation,
    ...(properties === undefined ? {} : { properties }),
    ...(designator === undefined ? {} : { designator }),
    ...(net === undefined ? {} : { net }),
    ...(reference === undefined ? {} : { reference }),
  };
}

/**
 * Reads a field that only some symbol roles may carry, so the format cannot describe a power
 * symbol with a reference designator or a resistor with a net name.
 */
function readRoleField(
  value: Record<string, unknown>,
  field: 'designator' | 'net',
  device: string | undefined,
  path: readonly string[],
  diagnostics: Diagnostic[],
  allowed: (role: SymbolRole) => boolean,
): string | undefined {
  const raw = value[field];
  if (raw === undefined || device === undefined) {
    return undefined;
  }
  const role = symbolRole(device);
  if (!allowed(role)) {
    report(
      diagnostics,
      'symbol/unsupported-field',
      `Symbols of role "${role}" must not declare "${field}".`,
      [...path, field],
    );
    return undefined;
  }
  return readStringField(value, field, path, diagnostics, { nonEmpty: true });
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
  const id = readId(value, path, diagnostics);
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
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous.x !== current.x && previous.y !== current.y) {
      report(diagnostics, 'wire/not-orthogonal', 'Wire segments must be horizontal or vertical.', [
        ...path,
        'points',
        String(index),
      ]);
      return undefined;
    }
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
  const id = readId(value, path, diagnostics);
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
