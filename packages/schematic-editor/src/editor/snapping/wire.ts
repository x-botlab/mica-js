import { projectOnSegment, type Point } from '@mica-js/core/schematic';
import type { DisplayOptions } from '../../controller/types';
import type { SnapContext } from './nodes';
import { connectionNodeAt } from './nodes';
import { snapToGrid } from './drag';

/**
 * Waypoints needed to reach `to` from `from` with horizontal/vertical segments only.
 * Returns `[to]` when already aligned, otherwise an elbow plus `to` (long axis first).
 */
export function orthogonalWaypoints(from: Point, to: Point): readonly Point[] {
  if (from.x === to.x || from.y === to.y) {
    return [to];
  }
  const elbow =
    Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
      ? { x: to.x, y: from.y }
      : { x: from.x, y: to.y };
  return [elbow, to];
}

export type WireAxis = 'horizontal' | 'vertical';

/**
 * Waypoints for one new wire leg. When the target lands on an existing wire the last leg runs
 * perpendicular to it, so the branch taps into a T instead of doubling back along the host.
 */
export function wireWaypoints(
  from: Point,
  to: Point,
  host: WireAxis | undefined,
): readonly Point[] {
  if (host === undefined || from.x === to.x || from.y === to.y) {
    return orthogonalWaypoints(from, to);
  }
  return host === 'vertical' ? [{ x: from.x, y: to.y }, to] : [{ x: to.x, y: from.y }, to];
}

/** Snaps to a nearby connection node, then to a nearby wire, otherwise to the grid. */
export function snapForWire(context: SnapContext, point: Point): Point {
  return (
    connectionNodeAt(context, point) ??
    wireBodyPointAt(context, point) ??
    snapToGrid(point, context.controller.getDisplay())
  );
}

/**
 * Closest point on an existing wire's run when `point` is within the snap radius. Lets the wire
 * tool land exactly on another wire, which is what turns the run into a T junction. Only the
 * offset beside the host is absorbed: the position along it still follows the grid.
 */
export function wireBodyPointAt(context: SnapContext, point: Point): Point | undefined {
  const radius = context.tolerance * 2;
  const display = context.controller.getDisplay();
  let best: { readonly point: Point; readonly distance: number } | undefined;
  for (const wire of context.controller.getDocument().sheet.wires) {
    for (let index = 1; index < wire.points.length; index += 1) {
      const a = wire.points[index - 1];
      const b = wire.points[index];
      if (a === undefined || b === undefined) {
        continue;
      }
      const projected = projectOnSegment(point, a, b);
      const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
      if (distance > radius || (best !== undefined && distance >= best.distance)) {
        continue;
      }
      best = { point: gridAlongHost(projected, a, b, display), distance };
    }
  }
  return best?.point;
}

function gridAlongHost(projected: Point, a: Point, b: Point, display: DisplayOptions): Point {
  // The axis normal to the host keeps the run's own coordinate so the tap stays on it; the axis
  // along the run follows the pointer, so it still has to honour the grid.
  if (a.y === b.y && a.x !== b.x) {
    const x = snapToGrid(projected, display).x;
    return x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x)
      ? { x, y: a.y }
      : { x: projected.x, y: a.y };
  }
  if (a.x === b.x && a.y !== b.y) {
    const y = snapToGrid(projected, display).y;
    return y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)
      ? { x: a.x, y }
      : { x: a.x, y: projected.y };
  }
  return { x: projected.x, y: projected.y };
}
