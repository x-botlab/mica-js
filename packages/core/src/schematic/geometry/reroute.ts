import type { Point, SchematicWire } from '../format/types';

export interface PointMove {
  readonly from: Point;
  readonly to: Point;
}

export interface ReroutedWire {
  readonly points: readonly Point[];
  /** Every point that changed, so junctions and anchors can follow. */
  readonly moves: readonly PointMove[];
}

/**
 * Moves a wire endpoint to `to` while keeping every segment horizontal or vertical.
 *
 * The displacement is absorbed segment by segment (the classic orthogonal drag): the point after
 * the moved end is shifted just enough to restore the original orientation, and the correction is
 * passed on until a segment can take it. No extra points are inserted, so the wire never doubles
 * back on itself.
 */
export function rerouteWireEndpoint(
  wire: SchematicWire,
  from: Point,
  to: Point,
): ReroutedWire | undefined {
  const points = wire.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  if (samePoint(first, from)) {
    return rerouteFrom(points, to, 'start');
  }
  if (samePoint(last, from)) {
    return rerouteFrom(points, to, 'end');
  }
  return undefined;
}

function rerouteFrom(points: readonly Point[], target: Point, end: 'start' | 'end'): ReroutedWire {
  const next = points.map((point) => ({ x: point.x, y: point.y }));
  const first = next[0];
  const last = next[next.length - 1];
  if (first === undefined || last === undefined) {
    return { points: next, moves: [] };
  }

  if (end === 'start') {
    next[0] = { x: target.x, y: target.y };
    for (let index = 0; index < next.length - 1; index += 1) {
      const a = next[index];
      const b = next[index + 1];
      if (a === undefined || b === undefined || a.x === b.x || a.y === b.y) {
        break;
      }
      const horizontal = points[index]?.y === points[index + 1]?.y;
      next[index + 1] = horizontal ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    }
  } else {
    next[next.length - 1] = { x: target.x, y: target.y };
    for (let index = next.length - 1; index > 0; index -= 1) {
      const a = next[index - 1];
      const b = next[index];
      if (a === undefined || b === undefined || a.x === b.x || a.y === b.y) {
        break;
      }
      const horizontal = points[index - 1]?.y === points[index]?.y;
      next[index - 1] = horizontal ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
    }
  }

  const moves: PointMove[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const before = points[index];
    const after = next[index];
    if (before !== undefined && after !== undefined && !samePoint(before, after)) {
      moves.push({ from: before, to: after });
    }
  }
  return { points: dropRepeatedPoints(next), moves };
}

function dropRepeatedPoints(points: readonly Point[]): readonly Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (previous === undefined || !samePoint(previous, point)) {
      result.push(point);
    }
  }
  return result.length >= 2 ? result : points;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}
