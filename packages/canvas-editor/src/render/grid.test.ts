import { describe, expect, it } from 'vitest';
import { GRID_MAX_STEP, isMajorGridLine, resolveGridStep } from './grid';

describe('resolveGridStep', () => {
  it.each([0, -10, Number.NaN, Number.POSITIVE_INFINITY])(
    'skips the grid for a gridSize of %s instead of looping forever',
    (gridSize) => {
      expect(resolveGridStep(gridSize, 1)).toBeUndefined();
    },
  );

  it('skips the grid for an unusable zoom', () => {
    expect(resolveGridStep(10, 0)).toBeUndefined();
    expect(resolveGridStep(10, Number.NaN)).toBeUndefined();
  });

  it('keeps the theme step while the lines are readable', () => {
    expect(resolveGridStep(10, 1)).toBe(10);
    expect(resolveGridStep(10, 2)).toBe(10);
  });

  it('coarsens the step by five while zoomed out', () => {
    // 10 px is 1 screen pixel at 0.1×, 50 px is 5, 250 px is 25 and dense enough.
    expect(resolveGridStep(10, 0.1)).toBe(250);
  });

  it('terminates and stays bounded for an extreme zoom', () => {
    const step = resolveGridStep(10, 1e-12);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(GRID_MAX_STEP);
  });
});

describe('isMajorGridLine', () => {
  it('marks every fifth line', () => {
    expect(isMajorGridLine(0, 10)).toBe(true);
    expect(isMajorGridLine(10, 10)).toBe(false);
    expect(isMajorGridLine(50, 10)).toBe(true);
    expect(isMajorGridLine(-50, 10)).toBe(true);
  });

  it('rejects a degenerate step', () => {
    expect(isMajorGridLine(0, 0)).toBe(false);
    expect(isMajorGridLine(10, Number.NaN)).toBe(false);
  });
});
