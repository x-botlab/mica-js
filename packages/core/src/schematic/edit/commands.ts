import type { Diagnostic } from '../format/diagnostics';
import { throwIfErrors } from '../format/errors';
import { parseSchematic } from '../format/parse-schematic';
import type { Point, SchematicDocument, SchematicJunction, SchematicWire } from '../format/types';
import { toPointer } from '../format/validate';
import { parseDeviceReference } from '../device/reference';
import type { TopologyOptions } from '../topology/derive';
import { DEFAULT_TOLERANCE, pointOnPolyline } from '../geometry/point';
import { defaultElementIdFactory, type ElementIdFactory } from './ids';

export type SchematicCommand =
  | {
      readonly type: 'add-symbol';
      readonly id?: string;
      readonly device: string;
      readonly x: number;
      readonly y: number;
      readonly rotation?: number;
    }
  | {
      readonly type: 'update-symbol';
      readonly id: string;
      readonly device?: string;
      readonly x?: number;
      readonly y?: number;
      readonly rotation?: number;
    }
  | { readonly type: 'remove-symbol'; readonly id: string }
  | { readonly type: 'add-wire'; readonly id?: string; readonly points: readonly Point[] }
  | { readonly type: 'set-wire-points'; readonly id: string; readonly points: readonly Point[] }
  | { readonly type: 'remove-wire'; readonly id: string }
  | {
      readonly type: 'add-junction';
      readonly id?: string;
      readonly x: number;
      readonly y: number;
      readonly wires: readonly string[];
    }
  | {
      readonly type: 'update-junction';
      readonly id: string;
      readonly x?: number;
      readonly y?: number;
      readonly wires?: readonly string[];
    }
  | { readonly type: 'remove-junction'; readonly id: string };

export interface EditEffect {
  readonly kind: 'junction-removed';
  readonly id: string;
  readonly reason: 'wire-removed' | 'junction-detached';
}

export interface SchematicEditOptions extends TopologyOptions {
  readonly createId?: ElementIdFactory;
  /** How to handle junctions that stop lying on a wire after its geometry changes. */
  readonly onJunctionConflict?: 'reject' | 'remove';
  /** Receives cascaded removals such as junctions dropped with their wire. */
  readonly onEffect?: (effect: EditEffect) => void;
}

/**
 * Applies an edit command to a copy of `document`.
 *
 * @throws {SchematicError} when the command is invalid; the input document is never mutated.
 */
export function applySchematicCommand(
  document: SchematicDocument,
  command: SchematicCommand,
  options: SchematicEditOptions = {},
): SchematicDocument {
  const symbols = [...document.sheet.symbols];
  const wires = [...document.sheet.wires];
  const junctions = [...document.sheet.junctions];
  const diagnostics: Diagnostic[] = [];
  const effects: EditEffect[] = [];
  const createId = options.createId ?? defaultElementIdFactory;
  const draft = (): SchematicDocument => ({ ...document, sheet: { symbols, wires, junctions } });

  switch (command.type) {
    case 'add-symbol': {
      const device = requireDevice(command.device, diagnostics);
      const id = command.id ?? createId('symbol', draft());
      if (device !== undefined) {
        symbols.push({
          id,
          device,
          x: command.x,
          y: command.y,
          rotation: command.rotation ?? 0,
        });
      }
      break;
    }
    case 'update-symbol': {
      const index = findIndex(symbols, command.id, 'symbol', diagnostics);
      const current = index === -1 ? undefined : symbols[index];
      if (current !== undefined) {
        const device =
          command.device === undefined
            ? current.device
            : requireDevice(command.device, diagnostics);
        if (device !== undefined) {
          symbols[index] = {
            id: current.id,
            device,
            x: command.x ?? current.x,
            y: command.y ?? current.y,
            rotation: command.rotation ?? current.rotation,
          };
        }
      }
      break;
    }
    case 'remove-symbol': {
      const index = findIndex(symbols, command.id, 'symbol', diagnostics);
      if (index !== -1) {
        symbols.splice(index, 1);
      }
      break;
    }
    case 'add-wire': {
      const id = command.id ?? createId('wire', draft());
      const wire = makeWire(id, command.points, diagnostics);
      if (wire !== undefined) {
        wires.push(wire);
      }
      break;
    }
    case 'set-wire-points': {
      const index = findIndex(wires, command.id, 'wire', diagnostics);
      if (index !== -1) {
        const wire = makeWire(command.id, command.points, diagnostics);
        if (wire !== undefined) {
          wires[index] = wire;
        }
      }
      break;
    }
    case 'remove-wire': {
      const index = findIndex(wires, command.id, 'wire', diagnostics);
      if (index !== -1) {
        wires.splice(index, 1);
        for (let junctionIndex = junctions.length - 1; junctionIndex >= 0; junctionIndex -= 1) {
          const junction = junctions[junctionIndex];
          if (junction === undefined || !junction.wires.includes(command.id)) {
            continue;
          }
          effects.push({ kind: 'junction-removed', id: junction.id, reason: 'wire-removed' });
          junctions.splice(junctionIndex, 1);
        }
      }
      break;
    }
    case 'add-junction': {
      const id = command.id ?? createId('junction', draft());
      const junction = makeJunction(id, command.x, command.y, command.wires, diagnostics);
      if (junction !== undefined) {
        junctions.push(junction);
      }
      break;
    }
    case 'update-junction': {
      const index = findIndex(junctions, command.id, 'junction', diagnostics);
      const current = index === -1 ? undefined : junctions[index];
      if (current !== undefined) {
        const junction = makeJunction(
          current.id,
          command.x ?? current.x,
          command.y ?? current.y,
          command.wires ?? current.wires,
          diagnostics,
        );
        if (junction !== undefined) {
          junctions[index] = junction;
        }
      }
      break;
    }
    case 'remove-junction': {
      const index = findIndex(junctions, command.id, 'junction', diagnostics);
      if (index !== -1) {
        junctions.splice(index, 1);
      }
      break;
    }
    default: {
      diagnostics.push({
        severity: 'error',
        code: 'edit/invalid-command',
        message: `Unsupported command ${JSON.stringify((command as { type?: unknown }).type)}.`,
      });
    }
  }

  throwIfErrors(diagnostics);

  const result = validateSheet(draft(), options, diagnostics, effects);
  throwIfErrors(diagnostics);

  for (const effect of effects) {
    options.onEffect?.(effect);
  }
  return result;
}

function validateSheet(
  candidate: SchematicDocument,
  options: SchematicEditOptions,
  diagnostics: Diagnostic[],
  effects: EditEffect[],
): SchematicDocument {
  // Structural re-validation: ids, required fields, wire point counts, junction references.
  const parsed = parseSchematic(candidate);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const wireById = new Map(parsed.sheet.wires.map((wire) => [wire.id, wire]));
  const survivingJunctions: SchematicJunction[] = [];
  let cascaded = false;

  for (const junction of parsed.sheet.junctions) {
    const detached = junction.wires.some((wireId) => {
      const wire = wireById.get(wireId);
      return (
        wire === undefined ||
        !pointOnPolyline(wire.points, { x: junction.x, y: junction.y }, tolerance)
      );
    });
    if (!detached) {
      survivingJunctions.push(junction);
      continue;
    }
    if (options.onJunctionConflict === 'remove') {
      cascaded = true;
      effects.push({ kind: 'junction-removed', id: junction.id, reason: 'junction-detached' });
      continue;
    }
    diagnostics.push({
      severity: 'error',
      code: 'junction/off-wire',
      message: `Junction "${junction.id}" no longer lies on every referenced wire.`,
      pointer: toPointer(['sheet', 'junctions']),
      entity: { kind: 'junction', id: junction.id },
    });
  }

  if (!cascaded) {
    return parsed;
  }
  return { ...parsed, sheet: { ...parsed.sheet, junctions: survivingJunctions } };
}

function makeWire(
  id: string,
  points: readonly Point[],
  diagnostics: Diagnostic[],
): SchematicWire | undefined {
  if (points.length < 2) {
    diagnostics.push({
      severity: 'error',
      code: 'wire/invalid-points',
      message: `Wire "${id}" must contain at least two points.`,
      entity: { kind: 'wire', id },
    });
    return undefined;
  }
  return { id, points: points.map((point) => ({ x: point.x, y: point.y })) };
}

function makeJunction(
  id: string,
  x: number,
  y: number,
  wires: readonly string[],
  diagnostics: Diagnostic[],
): SchematicJunction | undefined {
  if (wires.length < 2) {
    diagnostics.push({
      severity: 'error',
      code: 'schema/invalid-value',
      message: `Junction "${id}" must reference at least two wires.`,
      entity: { kind: 'junction', id },
    });
    return undefined;
  }
  return { id, x, y, wires: [...wires] };
}

function requireDevice(device: string, diagnostics: Diagnostic[]): string | undefined {
  if (parseDeviceReference(device) === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'device/invalid-reference',
      message: `Invalid device reference ${JSON.stringify(device)}.`,
    });
    return undefined;
  }
  return device;
}

function findIndex<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  kind: 'symbol' | 'wire' | 'junction',
  diagnostics: Diagnostic[],
): number {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    diagnostics.push({
      severity: 'error',
      code: 'edit/unknown-entity',
      message: `Unknown ${kind} "${id}".`,
      entity: { kind, id },
    });
  }
  return index;
}
