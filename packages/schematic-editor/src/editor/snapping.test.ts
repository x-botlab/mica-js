import { describe, expect, it } from 'vitest';
import { orthogonalWaypoints } from './snapping';

describe('orthogonalWaypoints', () => {
  it('returns the target alone when already aligned', () => {
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 0, y: 40 })).toEqual([{ x: 0, y: 40 }]);
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 40, y: 0 })).toEqual([{ x: 40, y: 0 }]);
  });

  it('routes horizontally first when the horizontal delta dominates', () => {
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 60, y: 20 })).toEqual([
      { x: 60, y: 0 },
      { x: 60, y: 20 },
    ]);
  });

  it('routes vertically first when the vertical delta dominates', () => {
    expect(orthogonalWaypoints({ x: 0, y: 0 }, { x: 20, y: 60 })).toEqual([
      { x: 0, y: 60 },
      { x: 20, y: 60 },
    ]);
  });

  it('only produces horizontal or vertical segments', () => {
    const path = [{ x: 10, y: 10 }, ...orthogonalWaypoints({ x: 10, y: 10 }, { x: 70, y: 40 })];
    for (let index = 1; index < path.length; index += 1) {
      const previous = path[index - 1]!;
      const current = path[index]!;
      expect(previous.x === current.x || previous.y === current.y).toBe(true);
    }
  });
});
