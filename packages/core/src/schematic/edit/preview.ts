import type { DeviceSymbolProvider } from '../device/symbol';
import type { Placement, Point, SchematicDocument } from '../format/types';
import { symbolPinPosition } from '../geometry/transform';
import { rerouteWireEndpoint } from '../geometry/reroute';

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

  const definition = pinAnchors(document, devices, symbol.device);
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
      const rerouted = rerouteWireEndpoint(wire, move.from, move.to);
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
      return points !== undefined && liesOnPolyline(points, point);
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
      const projected = projectOntoPolyline(before.points, point);
      if (projected === undefined) {
        continue;
      }
      junctions.set(junction.id, projectSegment(after, projected.segment, projected.t));
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

/** Segment index plus position along it for the closest point on a polyline. */
function projectOntoPolyline(
  points: readonly Point[],
  point: Point,
): { readonly segment: number; readonly t: number } | undefined {
  let best: { segment: number; t: number; distance: number } | undefined;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) {
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    const projected = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
    if (best === undefined || distance < best.distance) {
      best = { segment: index - 1, t, distance };
    }
  }
  return best === undefined ? undefined : { segment: best.segment, t: best.t };
}

function projectSegment(points: readonly Point[], segment: number, t: number): Point {
  const a = points[segment];
  const b = points[segment + 1] ?? a;
  if (a === undefined || b === undefined) {
    return { x: 0, y: 0 };
  }
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function pinAnchors(
  document: SchematicDocument,
  devices: DeviceSymbolProvider | undefined,
  device: string,
): Readonly<Record<string, Point>> {
  const separator = device.indexOf(':');
  if (separator <= 0 || devices === undefined) {
    return {};
  }
  const packageId = device.slice(0, separator);
  const deviceId = device.slice(separator + 1);
  return devices.getDeviceSymbol({ raw: device, packageId, deviceId })?.pins ?? {};
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

const ON_WIRE_EPSILON = 1e-6;

function liesOnPolyline(points: readonly Point[], point: Point): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) {
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const cross = (point.x - a.x) * dy - (point.y - a.y) * dx;
    if (lengthSquared === 0) {
      if (Math.hypot(point.x - a.x, point.y - a.y) <= ON_WIRE_EPSILON) {
        return true;
      }
      continue;
    }
    if (Math.abs(cross) / Math.sqrt(lengthSquared) > ON_WIRE_EPSILON) {
      continue;
    }
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    if (t >= -ON_WIRE_EPSILON && t <= 1 + ON_WIRE_EPSILON) {
      return true;
    }
  }
  return false;
}
