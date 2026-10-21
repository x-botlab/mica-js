import { projectOnSegment, type Point } from '@mica-js/core/schematic';
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
    snapToGrid(point, context.controller.display)
  );
}

/**
 * Closest point on an existing wire's run when `point` is within the snap radius. Lets the wire
 * tool land exactly on another wire, which is what turns the run into a T junction.
 */
export function wireBodyPointAt(context: SnapContext, point: Point): Point | undefined {
  const radius = context.tolerance * 2;
  let best: { readonly point: Point; readonly distance: number } | undefined;
  for (const wire of context.controller.document.sheet.wires) {
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
      best = { point: { x: projected.x, y: projected.y }, distance };
    }
  }
  return best?.point;
}
