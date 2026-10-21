import { describe, expect, it } from 'vitest';
import { rotatePoint, symbolBounds, symbolPinPosition } from './transform';

describe('transform', () => {
  it('rotates counter-clockwise in degrees', () => {
    const rotated = rotatePoint({ x: 10, y: 0 }, 90);
    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(10);
    expect(rotatePoint({ x: 2, y: 3 }, 0)).toEqual({ x: 2, y: 3 });
  });

  it('places pin anchors relative to the symbol origin', () => {
    expect(symbolPinPosition({ x: 100, y: 50, rotation: 0 }, { x: -10, y: 5 })).toEqual({
      x: 90,
      y: 55,
    });
    const rotated = symbolPinPosition({ x: 0, y: 0, rotation: 90 }, { x: 10, y: 0 });
    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(10);
  });

  it('derives symbol bounds from outline, pins or origin', () => {
    expect(
      symbolBounds({ x: 10, y: 10, rotation: 0 }, { x: -2, y: -2, width: 4, height: 4 }, {}),
    ).toEqual({ x: 8, y: 8, width: 4, height: 4 });

    expect(
      symbolBounds({ x: 0, y: 0, rotation: 0 }, undefined, {
        A: { x: 0, y: 0 },
        B: { x: 4, y: 2 },
      }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 4,
      height: 2,
    });

    expect(symbolBounds({ x: 3, y: 4, rotation: 0 }, undefined, {})).toEqual({
      x: 3,
      y: 4,
      width: 0,
      height: 0,
    });
  });
});
