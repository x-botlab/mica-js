/**
 * Grid math of the canvas renderer. Kept free of the canvas API so the degenerate cases a host can
 * reach through `theme.gridSize` stay unit-testable.
 */

/** Smallest on-screen gap between grid lines, in CSS pixels. */
export const GRID_MIN_GAP = 6;
/** Hard upper bound of the grid step, so a very small zoom cannot loop for long. */
export const GRID_MAX_STEP = 1e6;
/** Factor the step grows by when the lines would be denser than {@link GRID_MIN_GAP}. */
export const GRID_SUBDIVISION = 5;
/** Every n-th line is drawn with the major color. */
export const GRID_MAJOR_INTERVAL = 5;

/**
 * Effective grid step in document units, or `undefined` when the grid must not be drawn.
 *
 * A host hides the grid by passing `theme.gridSize = 0`; a non-positive or non-finite size (and an
 * unusable zoom) therefore yields `undefined` instead of an endlessly growing step. Multiplying by
 * a non-positive number never reaches the upper bound, so the loop is guarded on both sides.
 */
export function resolveGridStep(gridSize: number, scale: number): number | undefined {
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    return undefined;
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    return undefined;
  }
  let step = gridSize;
  while (step * scale < GRID_MIN_GAP && step * GRID_SUBDIVISION <= GRID_MAX_STEP) {
    step *= GRID_SUBDIVISION;
  }
  return step;
}

/** Whether the line at `value` is a major (emphasized) grid line. */
export function isMajorGridLine(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return false;
  }
  return Math.round(value / step) % GRID_MAJOR_INTERVAL === 0;
}
