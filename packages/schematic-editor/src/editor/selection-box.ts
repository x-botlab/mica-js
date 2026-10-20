import {
  parseDeviceReference,
  symbolBounds,
  type DeviceSymbolProvider,
  type Point,
  type Rect,
  type SchematicDocument,
} from '@mica/core/schematic';
import type { EditorSelection } from '../controller/types';

export function rectOf(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectsIntersect(left: Rect, right: Rect): boolean {
  return (
    left.x + left.width >= right.x &&
    left.x <= right.x + right.width &&
    left.y + left.height >= right.y &&
    left.y <= right.y + right.height
  );
}

/** Everything touched by the rubber-band rectangle. */
export function marqueeSelection(
  document: SchematicDocument,
  rect: Rect,
  devices: DeviceSymbolProvider | undefined,
): readonly EditorSelection[] {
  if (rect.width === 0 && rect.height === 0) {
    return [];
  }
  const result: EditorSelection[] = [];
  for (const symbol of document.sheet.symbols) {
    if (rectsIntersect(symbolRect(symbol, devices), rect)) {
      result.push({ kind: 'symbol', id: symbol.id });
    }
  }
  for (const wire of document.sheet.wires) {
    if (wire.points.some((point) => pointInRect(point, rect))) {
      result.push({ kind: 'wire', id: wire.id });
    }
  }
  for (const junction of document.sheet.junctions) {
    if (pointInRect({ x: junction.x, y: junction.y }, rect)) {
      result.push({ kind: 'junction', id: junction.id });
    }
  }
  return result;
}

function symbolRect(
  symbol: {
    readonly id: string;
    readonly device: string;
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
  },
  devices: DeviceSymbolProvider | undefined,
): Rect {
  const reference = parseDeviceReference(symbol.device);
  const definition = reference === undefined ? undefined : devices?.getDeviceSymbol(reference);
  return (
    (definition === undefined
      ? undefined
      : symbolBounds(symbol, definition.bounds, definition.pins)) ?? {
      x: symbol.x,
      y: symbol.y,
      width: 0,
      height: 0,
    }
  );
}
