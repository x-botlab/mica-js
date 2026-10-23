import type { Point } from '@mica-js/core/schematic';
import { snapToGrid, type WireAxis } from '../snapping';
import type { InteractionContext } from './context';

/** Starts dragging a wire segment; the moved run is snapped so it lands on grid lines. */
export function beginSegmentDrag(
  context: InteractionContext,
  page: Point,
  wireId: string,
): boolean {
  const hit = context.deps.controller.hitTest(page, {
    includeSymbols: false,
    tolerance: context.pointer.tolerance(),
  });
  if (hit?.kind !== 'wire' || hit.id !== wireId) {
    return false;
  }
  context.state.drag = {
    mode: 'segment',
    wireId: hit.id,
    segment: hit.segment,
    origin: page,
    delta: { x: 0, y: 0 },
  };
  return true;
}

/** Updates an in-flight segment drag; returns `true` when this drag is the active one. */
export function updateSegmentDrag(context: InteractionContext, page: Point): boolean {
  const drag = context.state.drag;
  if (drag?.mode !== 'segment') {
    return false;
  }
  const wire = context.deps.controller
    .getDocument()
    .sheet.wires.find((item) => item.id === drag.wireId);
  const start = wire?.points[drag.segment];
  const end = wire?.points[drag.segment + 1];
  if (wire === undefined || start === undefined || end === undefined) {
    return true;
  }
  // Segments only slide along their normal, so the wire stays orthogonal; the moved vertex is
  // snapped (not the delta) so the run lands on grid lines.
  const horizontal = start.y === end.y;
  const target = snapToGrid(
    horizontal
      ? { x: start.x, y: start.y + (page.y - drag.origin.y) }
      : { x: start.x + (page.x - drag.origin.x), y: start.y },
    context.deps.controller.getDisplay(),
  );
  const candidate = horizontal ? { x: 0, y: target.y - start.y } : { x: target.x - start.x, y: 0 };
  if (candidate.x !== drag.delta.x || candidate.y !== drag.delta.y) {
    context.state.drag = { ...drag, delta: candidate };
    context.deps.onChange();
  }
  return true;
}

/** Commits a finished segment drag; returns whether an edit was recorded. */
export function finishSegmentDrag(
  context: InteractionContext,
  drag: { readonly wireId: string; readonly segment: number; readonly delta: Point },
): boolean {
  if (drag.delta.x === 0 && drag.delta.y === 0) {
    return false;
  }
  context.deps.run(() =>
    context.deps.controller.moveWireSegment(drag.wireId, drag.segment, drag.delta),
  );
  return true;
}

/** Wire preview for the renderer, plus the orientation helper used by the wire tool. */
export function wirePreview(
  context: InteractionContext,
): { readonly wireId: string; readonly points: readonly Point[] } | undefined {
  const drag = context.state.drag;
  if (drag?.mode !== 'segment') {
    return undefined;
  }
  const points = context.deps.controller.previewWireSegment(drag.wireId, drag.segment, drag.delta);
  return points === undefined ? undefined : { wireId: drag.wireId, points };
}

export type { WireAxis };
