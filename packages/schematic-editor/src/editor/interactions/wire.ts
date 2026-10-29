import type { Point } from '@mica-js/core/schematic';
import { connectionNodeAt, wireWaypoints } from '../snapping';
import { annotationSymbolAt } from './selection';
import type { InteractionContext } from './context';

/** Adds the next waypoint of the wire being drawn, closing the run on a connection. */
export function addWirePoint(context: InteractionContext, page: Point): void {
  const state = context.state;
  const point = context.pointer.snapWire(page);
  const previous = state.pendingWire[state.pendingWire.length - 1];
  state.pendingWire = [
    ...state.pendingWire,
    ...(previous === undefined
      ? [point]
      : wireWaypoints(previous, point, context.pointer.hostAxisAt(point))),
  ];
  state.cursorPoint = point;
  // Landing on another endpoint (pin, anchor, wire end) or an existing wire closes the run.
  const node = connectionNodeAt(context.pointer.snapContext(), point);
  const host = context.deps.editor.hitTest(point, {
    includeSymbols: false,
    tolerance: context.pointer.tolerance(),
  });
  const closes = node !== undefined || host?.kind === 'wire';
  if (closes && state.pendingWire.length >= 2) {
    finishWire(context);
    context.deps.editor.setTool('select');
    return;
  }
  context.deps.onChange();
}

/** Commits the pending wire as one edit; nothing is written in read-only mode. */
export function finishWire(context: InteractionContext): void {
  const points = context.state.pendingWire;
  context.state.pendingWire = [];
  context.state.cursorPoint = undefined;
  context.state.hover = undefined;
  if (points.length < 2 || context.deps.readOnly) {
    context.deps.onChange();
    return;
  }
  context.deps.run(() => context.deps.editor.addWire(points));
}

/** Pending wire plus the live cursor leg, for the dashed preview. */
export function pendingWireWithCursor(context: InteractionContext): readonly Point[] {
  const state = context.state;
  const cursor = state.cursorPoint;
  if (cursor === undefined) {
    return state.pendingWire;
  }
  const previous = state.pendingWire[state.pendingWire.length - 1];
  if (previous === undefined) {
    return [cursor];
  }
  return [
    ...state.pendingWire,
    ...wireWaypoints(previous, cursor, context.pointer.hostAxisAt(cursor)),
  ];
}

/** Clicking a pin or wire end in select mode starts a wire from there. */
export function startWireAtNode(context: InteractionContext, page: Point): boolean {
  const editor = context.deps.editor;
  if (editor.getTool() !== 'select' || context.deps.readOnly) {
    return false;
  }
  // Net labels, ports and text are selection/drag targets, so a tap on their body must not be
  // eaten by a new wire; the wire tool still connects to their anchors by snapping to them.
  if (annotationSymbolAt(context, page)) {
    return false;
  }
  const node = connectionNodeAt(context.pointer.snapContext(), page);
  if (node === undefined) {
    return false;
  }
  // Switch the tool first: the tool change resets transient state, which must not eat the anchor.
  editor.setTool('wire');
  context.state.pendingWire = [node];
  context.state.cursorPoint = node;
  context.deps.onChange();
  return true;
}
