import type { Point } from '@mica-js/core/schematic';
import type { DisplayOptions } from '../../controller/types';

export function snapToGrid(point: Point, display: DisplayOptions): Point {
  if (!display.snap || !(display.gridSize > 0)) {
    return point;
  }
  const size = display.gridSize;
  return { x: Math.round(point.x / size) * size, y: Math.round(point.y / size) * size };
}

/**
 * Offset for dragging something anchored at `anchor` from `from` to `to`: the result is snapped,
 * not the raw pointer delta, so an off-grid symbol lands on the grid.
 *
 * A drag that stays within half a grid cell on one axis does not move that axis at all, so an
 * anchor that started off-grid keeps its column/row instead of jittering sideways.
 */
export function snapDragOffset(
  anchor: Point,
  from: Point,
  to: Point,
  display: DisplayOptions,
): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!display.snap || !(display.gridSize > 0)) {
    return { x: dx, y: dy };
  }
  const target = snapToGrid({ x: anchor.x + dx, y: anchor.y + dy }, display);
  const lock = display.gridSize / 2;
  return {
    x: (Math.abs(dx) < lock ? anchor.x : target.x) - anchor.x,
    y: (Math.abs(dy) < lock ? anchor.y : target.y) - anchor.y,
  };
}
