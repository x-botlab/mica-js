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
