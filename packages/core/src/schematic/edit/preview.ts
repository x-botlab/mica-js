import { namesNet, symbolRole } from '../device/reference';
import type { DeviceSymbolProvider } from '../device/symbol';
import type { Placement, SchematicDocument } from '../../format/types';
import type { Point } from '../../format/value';
import { symbolPinPosition } from '../geometry/transform';
import {
  nearestPointOnPolyline,
  pointOnPolyline,
  pointOnPolylineAt,
  samePoint,
} from '../geometry/point';
import { rerouteWireEndpoint, stretchWireEndpoint } from '../geometry/reroute';

export interface SymbolDragPreview {
  /** New point lists for wires whose endpoint is attached to a moving pin. */
  readonly wires: ReadonlyMap<string, readonly Point[]>;
  /** New positions for junctions sitting on a moving pin. */
  readonly junctions: ReadonlyMap<string, Point>;
  /** New positions for anchors (power / ground / label) attached to a moving pin. */
  readonly symbols: ReadonlyMap<string, Point>;
}

/**
 * Geometry of a symbol being dragged or rotated: which wires, junctions and anchors follow.
 * Shared by the editor controller (commit) and the renderer (live preview).
 */
export function previewSymbolDrag(
  document: SchematicDocument,
  devices: DeviceSymbolProvider | undefined,
  symbolId: string,
  next: Placement,
): SymbolDragPreview | undefined {
  const symbol = document.sheet.symbols.find((candidate) => candidate.id === symbolId);
  if (symbol === undefined) {
    return undefined;
  }

  // Net labels and ports stretch their wire; component pins keep the run attached to the pin.
  const stretches = isNetAnchor(symbol.device);
  const definition = connectionAnchors(devices, symbol.device);
  const moves: { readonly from: Point; readonly to: Point }[] = [];
  for (const anchor of Object.values(definition)) {
    const from = symbolPinPosition(symbol, anchor);
    const to = symbolPinPosition(next, anchor);
    if (from.x !== to.x || from.y !== to.y) {
      moves.push({ from, to });
    }
  }

  const wires = new Map<string, readonly Point[]>();
  const junctions = new Map<string, Point>();
  const symbols = new Map<string, Point>();
  if (moves.length === 0) {
    return { wires, junctions, symbols };
  }

  const pointMoves = [...moves];
  for (const wire of document.sheet.wires) {
    for (const move of moves) {
      const rerouted = stretches
        ? stretchWireEndpoint(wire, move.from, move.to)
        : rerouteWireEndpoint(wire, move.from, move.to);
      if (rerouted === undefined) {
        continue;
      }
      wires.set(wire.id, rerouted.points);
      for (const extra of rerouted.moves) {
        if (!pointMoves.some((candidate) => samePoint(candidate.from, extra.from))) {
          pointMoves.push(extra);
        }
      }
      break;
    }
  }

  // Junctions that still lie on their (rerouted) wires stay put; only detached ones are re-placed.
  for (const junction of document.sheet.junctions) {
    const point = { x: junction.x, y: junction.y };
    const attached = junction.wires.every((wireId) => {
      const points = wires.get(wireId) ?? document.sheet.wires.find((w) => w.id === wireId)?.points;
      return points !== undefined && pointOnPolyline(points, point, ON_WIRE_EPSILON);
    });
    if (attached) {
      continue;
    }
    for (const wireId of junction.wires) {
      const before = document.sheet.wires.find((candidate) => candidate.id === wireId);
      const after = wires.get(wireId);
      if (before === undefined || after === undefined) {
        continue;
      }
      const projected = nearestPointOnPolyline(before.points, point);
      const moved =
        projected === undefined
          ? undefined
          : pointOnPolylineAt(after, projected.segment, projected.t);
      if (moved === undefined) {
        continue;
      }
      junctions.set(junction.id, moved);
      break;
    }
  }

  for (const move of pointMoves) {
    for (const junction of document.sheet.junctions) {
      if (samePoint({ x: junction.x, y: junction.y }, move.from)) {
        junctions.set(junction.id, move.to);
      }
    }
    for (const other of document.sheet.symbols) {
      if (other.id !== symbolId && samePoint({ x: other.x, y: other.y }, move.from)) {
        symbols.set(other.id, move.to);
      }
    }
  }

  return { wires, junctions, symbols };
}

/** True for the builtin anchors that name a net: net labels, power and ground. */
function isNetAnchor(device: string): boolean {
  return namesNet(symbolRole(device));
}

/**
 * Connection points of a device in symbol-local space. Net labels, power and ground symbols connect
 * at their own anchor, so they report one at the origin and drag their wire end like a pin does.
 */
function connectionAnchors(
  devices: DeviceSymbolProvider | undefined,
  device: string,
): Readonly<Record<string, Point>> {
  if (isNetAnchor(device)) {
    return { net: { x: 0, y: 0 } };
  }
  if (symbolRole(device) !== 'component') {
    // Text symbols connect nowhere.
    return {};
  }
  const separator = device.indexOf(':');
  if (separator <= 0 || devices === undefined) {
    return {};
  }
  const packageId = device.slice(0, separator);
  const deviceId = device.slice(separator + 1);
  return devices.getDeviceSymbol({ raw: device, packageId, deviceId })?.pins ?? {};
}

const ON_WIRE_EPSILON = 1e-6;
