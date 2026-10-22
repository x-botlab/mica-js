import { describe, expect, it } from 'vitest';
import type { Point } from '../../format/value';
import {
  boundsOfPoints,
  distanceToSegment,
  nearestPointOnPolyline,
  pointOnPolyline,
  pointOnPolylineAt,
  pointOnSegment,
  pointsEqual,
  projectOnSegment,
  samePoint,
  unionBounds,
} from './point';

const line: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
];

describe('geometry primitives', () => {
  it('compares points with tolerance', () => {
    expect(pointsEqual({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(pointsEqual({ x: 0, y: 0 }, { x: 0.1, y: 0 })).toBe(false);
    expect(pointsEqual({ x: 0, y: 0 }, { x: 0.1, y: 0 }, 0.2)).toBe(true);
  });

  it('detects points on a segment', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(pointOnSegment({ x: 5, y: 0 }, a, b)).toBe(true);
    expect(pointOnSegment(a, a, b)).toBe(true);
    expect(pointOnSegment(b, a, b)).toBe(true);
    expect(pointOnSegment({ x: 5, y: 1 }, a, b)).toBe(false);
    expect(pointOnSegment({ x: 11, y: 0 }, a, b)).toBe(false);
    expect(pointOnSegment({ x: 0, y: 0 }, a, a)).toBe(true);
  });

  it('detects points on a polyline', () => {
    expect(pointOnPolyline(line, { x: 5, y: 0 })).toBe(true);
    expect(pointOnPolyline(line, { x: 10, y: 5 })).toBe(true);
    expect(pointOnPolyline(line, { x: 10, y: 10 })).toBe(true);
    expect(pointOnPolyline(line, { x: 5, y: 5 })).toBe(false);
    expect(pointOnPolyline([{ x: 1, y: 1 }], { x: 1, y: 1 })).toBe(true);
  });

  it('measures the distance to a segment', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it('computes and unions bounds', () => {
    expect(boundsOfPoints([])).toBeUndefined();
    expect(boundsOfPoints([{ x: 1, y: 2 }])).toEqual({ x: 1, y: 2, width: 0, height: 0 });
    const bounds = boundsOfPoints([
      { x: -1, y: 2 },
      { x: 3, y: -4 },
    ]);
    expect(bounds).toEqual({ x: -1, y: -4, width: 4, height: 6 });
    expect(unionBounds(undefined, bounds)).toEqual(bounds);
    expect(unionBounds(bounds, undefined)).toEqual(bounds);
    expect(unionBounds(bounds, { x: 0, y: 0, width: 1, height: 1 })).toEqual({
      x: -1,
      y: -4,
      width: 4,
      height: 6,
    });
  });
});

describe('projection helpers', () => {
  it('compares exact points', () => {
    expect(samePoint({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(samePoint({ x: 1, y: 2 }, { x: 1.000001, y: 2 })).toBe(false);
  });

  it('projects onto a segment and clamps to its ends', () => {
    expect(projectOnSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({
      x: 5,
      y: 0,
      t: 0.5,
    });
    expect(projectOnSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({
      x: 0,
      y: 0,
      t: 0,
    });
    expect(projectOnSegment({ x: 4, y: 4 }, { x: 2, y: 2 }, { x: 2, y: 2 })).toEqual({
      x: 2,
      y: 2,
      t: 0,
    });
  });

  it('finds the closest polyline point with its segment', () => {
    expect(nearestPointOnPolyline(line, { x: 12, y: 6 })).toEqual({
      point: { x: 10, y: 6 },
      segment: 1,
      t: 0.6,
      distance: 2,
    });
    expect(nearestPointOnPolyline([{ x: 3, y: 4 }], { x: 0, y: 0 })).toEqual({
      point: { x: 3, y: 4 },
      segment: 0,
      t: 0,
      distance: 5,
    });
    expect(nearestPointOnPolyline([], { x: 0, y: 0 })).toBeUndefined();
  });

  it('reads a point at a position along a segment', () => {
    expect(pointOnPolylineAt(line, 1, 0.5)).toEqual({ x: 10, y: 5 });
    expect(pointOnPolylineAt(line, 9, 0.5)).toBeUndefined();
  });
});
