import { describe, expect, it } from 'vitest';
import { areaOfRings, parseAcrylicContour, parseSvgPath } from './contour';
import { buildAcrylicMesh } from './mesh';

const area = (ring: readonly { x: number; y: number }[]): number =>
  ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;

const rect = (width = 0.1, height = 0.1) => ({ type: 'rect' as const, width, height });

describe('acrylic contour parsing', () => {
  it('parses rect, circle, polygon and compound rings with canonical winding', () => {
    const polygon = {
      type: 'polygon' as const,
      points: [
        { x: 0, y: 0 },
        { x: 0.1, y: 0 },
        { x: 0.1, y: 0.1 },
      ],
    };
    expect(parseAcrylicContour(rect()).rings[0]).toHaveLength(4);
    expect(
      parseAcrylicContour({ type: 'circle', radius: 0.05 }, { segmentCount: 12 }).rings[0],
    ).toHaveLength(12);
    expect(parseAcrylicContour(polygon).rings[0]).toHaveLength(3);
    const compound = parseAcrylicContour(
      { type: 'compound', outer: rect(), holes: [{ type: 'circle', radius: 0.01 }] },
      { segmentCount: 16 },
    );
    expect(compound.rings).toHaveLength(2);
    expect(area(compound.rings[0]!)).toBeGreaterThan(0);
    expect(area(compound.rings[1]!)).toBeLessThan(0);
  });

  it('computes signed and net areas', () => {
    const width = 0.1;
    const height = 0.2;
    expect(parseAcrylicContour(rect(width, height)).area).toBeCloseTo(width * height);
    const radius = 0.02;
    const withHole = parseAcrylicContour(
      { type: 'compound', outer: rect(width, height), holes: [{ type: 'circle', radius }] },
      { segmentCount: 64 },
    );
    expect(withHole.area).toBeCloseTo(width * height - Math.PI * radius * radius, 2);
    expect(
      areaOfRings([
        [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 0 },
        ],
      ]),
    ).toBeLessThan(0);
  });

  it('rejects self-intersecting, degenerate and out-of-bounds holes', () => {
    expect(() =>
      parseAcrylicContour({
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
          { x: 1, y: 0 },
        ],
      }),
    ).toThrow(/self-intersect/i);
    expect(() =>
      parseAcrylicContour({
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      }),
    ).toThrow(/at least 3/i);
    expect(() =>
      parseAcrylicContour({
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
      }),
    ).toThrow(/non-zero area/i);
    expect(() =>
      parseAcrylicContour({
        type: 'compound',
        outer: rect(),
        holes: [{ type: 'rect', width: 0.2, height: 0.2 }],
      }),
    ).toThrow(/inside/i);
  });

  it('supports the SVG line subset and fixed curve sampling', () => {
    const svg = parseAcrylicContour({ type: 'svg', path: 'M 0 0 H .1 V .1 L 0 .1 Z' });
    expect(svg.rings[0]).toEqual(
      parseAcrylicContour({
        type: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 0.1, y: 0 },
          { x: 0.1, y: 0.1 },
          { x: 0, y: 0.1 },
        ],
      }).rings[0],
    );
    expect(parseSvgPath('M 0 0 C 0 .1 .1 .1 .1 0 Z', 4)[0]).toHaveLength(5);
    expect(parseSvgPath('M 0 0 Q .1 .1 .2 0 Z', 5)[0]).toHaveLength(6);
    expect(() => parseSvgPath('M 0 0 A 1 1 0 0 1 1 1 Z')).toThrowError(
      expect.objectContaining({ name: 'TypeError', message: expect.stringContaining('A') }),
    );
  });

  it('aligns the generated mesh to center, min and max origins', () => {
    const definition = (origin: 'center' | 'min' | 'max') => ({
      contour: rect(0.2, 0.1),
      thickness: 0.003,
      origin,
    });
    expect(buildAcrylicMesh(definition('center')).bounds.min.x).toBeCloseTo(-0.1);
    expect(buildAcrylicMesh(definition('min')).bounds.min.x).toBeCloseTo(0);
    expect(buildAcrylicMesh(definition('max')).bounds.max.x).toBeCloseTo(0);
  });
});
