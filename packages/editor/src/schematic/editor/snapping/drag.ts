import type { Point } from '@mica-js/document/schematic';
import type { IDisplayOptions } from '../../types';

export function snapToGrid(point: Point, display: IDisplayOptions): Point {
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
 * Dragging uses the fine grid spacing (`gridSize / gridSubdivisions`).
 * A drag that stays within half a fine grid cell on one axis does not move that axis at all, so an
 * anchor that started off-grid keeps its column/row instead of jittering sideways.
 */
export function snapDragOffset(
  anchor: Point,
  from: Point,
  to: Point,
  display: IDisplayOptions,
): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!display.snap || !(display.gridSize > 0)) {
    return { x: dx, y: dy };
  }
  const subdivisions =
    Number.isFinite(display.gridSubdivisions) && display.gridSubdivisions >= 1
      ? Math.round(display.gridSubdivisions)
      : 1;
  const size = display.gridSize / subdivisions;
  const target = snapToGrid({ x: anchor.x + dx, y: anchor.y + dy }, { ...display, gridSize: size });
  const lock = size / 2;
  return {
    x: (Math.abs(dx) < lock ? anchor.x : target.x) - anchor.x,
    y: (Math.abs(dy) < lock ? anchor.y : target.y) - anchor.y,
  };
}
