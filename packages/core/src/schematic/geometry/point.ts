import type { Point, Rect } from '../format/types';

/** Default comparison tolerance, in page units. */
export const DEFAULT_TOLERANCE = 0;

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pointsEqual(a: Point, b: Point, tolerance = DEFAULT_TOLERANCE): boolean {
  return distance(a, b) <= tolerance;
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
