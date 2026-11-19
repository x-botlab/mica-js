import { describe, expect, it } from 'vitest';
import { parseGeometry2D } from './geometry';
import { catchError, codesOf, pointersOf } from './test-helpers';

const PINS = ['a1', 'a2', 'b1', 'b2'];

/** The full-field geometry of RFC 0022. */
function geometry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sizing: 'physical',
    bounds: { x: -1, y: -1, width: 8, height: 8 },
    bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
    bodyImage: 'assets/body.svg',
    pins: {
      a1: {
        position: { x: -0.5, y: 1 },
        outward: { x: -1, y: 0 },
        label: { position: { x: -0.8, y: 0.5 }, visible: true },
      },
      a2: {
        position: { x: -0.5, y: 5 },
        outward: { x: -1, y: 0 },
        label: { position: { x: -0.8, y: 5.5 }, visible: true },
      },
      b1: {
        position: { x: 6.5, y: 1 },
        outward: { x: 1, y: 0 },
        label: { position: { x: 6.6, y: 0.5 }, visible: true },
      },
      b2: {
        position: { x: 6.5, y: 5 },
        outward: { x: 1, y: 0 },
        label: { position: { x: 6.6, y: 5.5 }, visible: true },
      },
    },
    designator: { x: 0, y: -1 },
    ...overrides,
  };
}

function parseError(value: unknown, pins?: readonly string[]): ReturnType<typeof catchError> {
  return catchError(() => parseGeometry2D(value, pins));
}

describe('parseGeometry2D', () => {
  it('parses the full RFC 0022 geometry', () => {
    const value = parseGeometry2D(geometry(), PINS);

    expect(value.sizing).toBe('physical');
    expect(value.bounds).toEqual({ x: -1, y: -1, width: 8, height: 8 });
    expect(value.bodyImage).toBe('assets/body.svg');
    expect(Object.keys(value.pins)).toEqual(PINS);
    expect(value.pins['a1']).toEqual({
      position: { x: -0.5, y: 1 },
      outward: { x: -1, y: 0 },
      label: { position: { x: -0.8, y: 0.5 }, visible: true },
    });
    expect(value.designator).toEqual({ x: 0, y: -1 });
  });

  it('parses geometry JSON text', () => {
    const value = parseGeometry2D(JSON.stringify(geometry()), PINS);

    expect(value.sizing).toBe('physical');
  });

  it('rejects a geometry pin set that differs from the device pins', () => {
    const error = parseError(geometry(), ['a1', 'a2']);

    expect(codesOf(error)).toEqual(['view2d/pin-mismatch']);
    expect(pointersOf(error)).toEqual(['/pins']);
  });

  it('rejects a zero outward vector', () => {
    const value = geometry();
    value['pins'] = { a1: { position: { x: 0, y: 0 }, outward: { x: 0, y: 0 } } };
    const error = parseError(value, ['a1']);

    expect(codesOf(error)).toEqual(['view2d/invalid-geometry']);
    expect(pointersOf(error)).toEqual(['/pins/a1/outward']);
  });

  it('rejects a non-positive bounds size', () => {
    const error = parseError(geometry({ bounds: { x: 0, y: 0, width: 0, height: 8 } }), PINS);

    expect(codesOf(error)).toEqual(['schema/invalid-value']);
    expect(pointersOf(error)).toEqual(['/bounds/width']);
  });

  it('rejects a body outside the drawing bounds', () => {
    const error = parseError(geometry({ bodyBounds: { x: 0, y: 0, width: 20, height: 6 } }), PINS);

    expect(codesOf(error)).toEqual(['view2d/invalid-geometry']);
    expect(pointersOf(error)).toEqual(['/bodyBounds']);
  });

  it('rejects a body image that is not PNG or SVG', () => {
    const error = parseError(geometry({ bodyImage: 'assets/body.webp' }), PINS);

    expect(codesOf(error)).toEqual(['view2d/invalid-geometry']);
    expect(pointersOf(error)).toEqual(['/bodyImage']);
  });

  it('rejects a body image path outside the package', () => {
    const error = parseError(geometry({ bodyImage: '../assets/body.svg' }), PINS);

    expect(codesOf(error)).toEqual(['view2d/invalid-geometry']);
    expect(pointersOf(error)).toEqual(['/bodyImage']);
  });

  it('rejects an unknown geometry field', () => {
    const error = parseError(geometry({ rotation: 90 }), PINS);

    expect(codesOf(error)).toEqual(['schema/unknown-field']);
    expect(pointersOf(error)).toEqual(['/rotation']);
  });
});
