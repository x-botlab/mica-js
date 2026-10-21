import type { Point, Rect } from '../format/types';

/** Default comparison tolerance, in page units. */
export const DEFAULT_TOLERANCE = 0;

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export function pointsEqual(a: Point, b: Point, tolerance = DEFAULT_TOLERANCE): boolean {
  return distance(a, b) <= tolerance;
}

/** Closest point on the closed segment `a`–`b`, plus its position `t` in `[0, 1]`. */
export function projectOnSegment(
  point: Point,
  a: Point,
  b: Point,
): { readonly x: number; readonly y: number; readonly t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { x: a.x, y: a.y, t: 0 };
  }
  const raw = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return { x: a.x + dx * t, y: a.y + dy * t, t };
}

export interface SegmentProjection {
  /** Closest point of the polyline. */
  readonly point: Point;
  /** Index of the segment that holds the closest point. */
  readonly segment: number;
  /** Position along that segment, in `[0, 1]`. */
  readonly t: number;
  readonly distance: number;
}

/** Closest point on a polyline, with the segment it belongs to; `undefined` when empty. */
export function nearestPointOnPolyline(
  points: readonly Point[],
  point: Point,
): SegmentProjection | undefined {
  let best: SegmentProjection | undefined;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) {
      continue;
    }
    const projected = projectOnSegment(point, a, b);
    const candidate: SegmentProjection = {
      point: { x: projected.x, y: projected.y },
      segment: index - 1,
      t: projected.t,
      distance: distance(point, projected),
    };
    if (best === undefined || candidate.distance < best.distance) {
      best = candidate;
    }
  }
  const only = points[0];
  if (best === undefined && only !== undefined) {
    return { point: only, segment: 0, t: 0, distance: distance(point, only) };
  }
  return best;
}

/** Point at position `t` along segment `segment` of a polyline. */
export function pointOnPolylineAt(
  points: readonly Point[],
  segment: number,
  t: number,
): Point | undefined {
  const a = points[segment];
  if (a === undefined) {
    return undefined;
  }
  const b = points[segment + 1] ?? a;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** True when `point` lies on the closed segment `a`–`b`, within `tolerance`. */
export function pointOnSegment(
  point: Point,
  a: Point,
  b: Point,
  tolerance = DEFAULT_TOLERANCE,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return pointsEqual(point, a, tolerance);
  }
  const area = (point.x - a.x) * dy - (point.y - a.y) * dx;
  if (Math.abs(area) / length > tolerance) {
    return false;
  }
  const projection = ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length);
  const overhang = tolerance / length;
  if (projection < -overhang || projection > 1 + overhang) {
    return false;
  }
  return distanceToSegment(point, a, b) <= tolerance;
}

export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return distance(point, a);
  }
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return distance(point, { x: a.x + clamped * dx, y: a.y + clamped * dy });
}

/** True when `point` lies on any segment of the polyline, endpoints included. */
export function pointOnPolyline(
  points: readonly Point[],
  point: Point,
  tolerance = DEFAULT_TOLERANCE,
): boolean {
  if (points.length === 1) {
    const [only] = points;
    return only !== undefined && pointsEqual(only, point, tolerance);
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      pointOnSegment(point, previous, current, tolerance)
    ) {
      return true;
    }
  }
  return false;
}

export function boundsOfPoints(points: readonly Point[]): Rect | undefined {
  const [first, ...rest] = points;
  if (first === undefined) {
    return undefined;
  }
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (const point of rest) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionBounds(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
