import { parseDeviceReference, symbolRole } from '../device/reference';
import type { DeviceSymbolProvider } from '../device/symbol';
import type { SchematicDocument, SchematicWire } from '../../format/types';
import type { Point } from '../../format/value';
import { symbolPinPosition } from '../geometry/transform';

export interface SegmentDragOptions {
  readonly devices?: DeviceSymbolProvider;
}

/**
 * Wire points produced by sliding one segment by `delta` along its normal.
 *
 * The whole run of segments parallel to the dragged one moves along, so no neighbour is left
 * diagonal. Where that run ends at a pin, an anchor, a junction or another wire, the vertex stays
 * put and the wire gains a dogleg. Pure geometry: the caller decides how to apply it.
 */
export function planSegmentDrag(
  document: SchematicDocument,
  wireId: string,
  segment: number,
  delta: Point,
  options: SegmentDragOptions = {},
): readonly Point[] | undefined {
  const wire = document.sheet.wires.find((candidate) => candidate.id === wireId);
  return wire === undefined
    ? undefined
    : planWireSegmentDrag(document, wire, segment, delta, options);
}

function planWireSegmentDrag(
  document: SchematicDocument,
  wire: SchematicWire,
  segment: number,
  delta: Point,
  options: SegmentDragOptions,
): readonly Point[] | undefined {
  const points = wire.points;
  const start = points[segment];
  const end = points[segment + 1];
  if (start === undefined || end === undefined || (delta.x === 0 && delta.y === 0)) {
    return undefined;
  }
  if (start.x === end.x && start.y === end.y) {
    return undefined;
  }
  // Dragging a horizontal segment moves its run vertically; the run only breaks at a segment
  // pointing the other way (it just stretches) or at a connected vertex (it needs a dogleg).
  const horizontal = start.y === end.y;
  const isParallel = (from: Point, to: Point): boolean =>
    horizontal ? from.y === to.y : from.x === to.x;
  const connected = (point: Point): boolean => isConnectedVertex(document, point, wire.id, options);

  let first = segment;
  while (first > 0) {
    const previous = points[first - 1];
    const current = points[first];
    if (
      previous === undefined ||
      current === undefined ||
      !isParallel(previous, current) ||
      connected(current)
    ) {
      break;
    }
    first -= 1;
  }
  let last = segment + 1;
  while (last < points.length - 1) {
    const current = points[last];
    const next = points[last + 1];
    if (
      current === undefined ||
      next === undefined ||
      !isParallel(current, next) ||
      connected(current)
    ) {
      break;
    }
    last += 1;
  }

  const firstPoint = points[first];
  const lastPoint = points[last];
  if (firstPoint === undefined || lastPoint === undefined) {
    return undefined;
  }
  const shift = (point: Point): Point => ({ x: point.x + delta.x, y: point.y + delta.y });
  const moved: Point[] = [];
  for (let index = first; index <= last; index += 1) {
    const point = points[index];
    if (point !== undefined) {
      moved.push(shift(point));
    }
  }
  if (connected(firstPoint)) {
    moved.unshift(firstPoint);
  }
  if (connected(lastPoint)) {
    moved.push(lastPoint);
  }
  return [...points.slice(0, first), ...moved, ...points.slice(last + 1)];
}

/** True when something other than the wire itself is attached at `point`. */
export function isConnectedVertex(
  document: SchematicDocument,
  point: Point,
  wireId: string,
  options: SegmentDragOptions = {},
): boolean {
  const same = (candidate: Point): boolean => candidate.x === point.x && candidate.y === point.y;
  for (const junction of document.sheet.junctions) {
    if (same(junction)) {
      return true;
    }
  }
  for (const wire of document.sheet.wires) {
    if (wire.id !== wireId && wire.points.some(same)) {
      return true;
    }
  }
  for (const symbol of document.sheet.symbols) {
    const role = symbolRole(symbol.device);
    if (role !== 'component') {
      if (same({ x: symbol.x, y: symbol.y })) {
        return true;
      }
      continue;
    }
    const reference = parseDeviceReference(symbol.device);
    const definition =
      reference === undefined ? undefined : options.devices?.getDeviceSymbol(reference);
    if (definition === undefined) {
      continue;
    }
    for (const anchor of Object.values(definition.pins)) {
      if (same(symbolPinPosition(symbol, anchor))) {
        return true;
      }
    }
  }
  return false;
}
