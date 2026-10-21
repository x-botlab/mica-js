import type { Point } from '@mica-js/core/schematic';
import type { InteractionContext } from './context';
import { rotatePlacement } from './placement';
import { finishWire } from './wire';

/**
 * Cancels whatever interaction is pending: placement, the wire being drawn, a drag or the active
 * tool, and clears the selection. Returns whether there was anything to cancel.
 */
export function cancelInteraction(context: InteractionContext): boolean {
  const controller = context.deps.controller;
  const active =
    controller.placingDevice !== undefined ||
    controller.tool !== 'select' ||
    controller.selection.length > 0 ||
    context.state.pendingWire.length > 0 ||
    context.state.drag !== undefined;
  if (!active) {
    return false;
  }
  if (controller.placingDevice !== undefined) {
    controller.cancelPlacement();
  }
  context.state.reset();
  controller.setSelection([]);
  controller.setTool('select');
  context.deps.onChange();
  return true;
}

/** Keyboard shortcuts; the canvas keeps focus, so the root element owns the listener. */
export function handleKeyDown(context: InteractionContext, event: KeyboardEvent): void {
  const controller = context.deps.controller;
  const readOnly = context.deps.readOnly;

  if (event.key === ' ') {
    event.preventDefault();
    if (rotatePlacement(context, 90)) {
      return;
    }
    if (!readOnly) {
      context.deps.run(() => controller.rotateSelection(90));
    }
    return;
  }
  if (event.key === 'Escape') {
    cancelInteraction(context);
    return;
  }
  if (event.key === 'Enter') {
    if (controller.tool === 'wire') {
      finishWire(context);
    }
    return;
  }
  if (
    event.key === 'Backspace' &&
    controller.tool === 'wire' &&
    context.state.pendingWire.length > 0
  ) {
    event.preventDefault();
    context.state.pendingWire = context.state.pendingWire.slice(0, -1);
    context.deps.onChange();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    if (!readOnly) {
      context.deps.run(() => controller.deleteSelection());
    }
    return;
  }
  if (event.key === 'r' || event.key === 'R') {
    if (!readOnly) {
      context.deps.run(() => controller.rotateSelection(90));
    }
    return;
  }
  if (event.key === 'f' || event.key === 'F') {
    context.deps.onFit();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault();
    if (readOnly) {
      return;
    }
    if (event.shiftKey) {
      controller.redo();
    } else {
      controller.undo();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
    event.preventDefault();
    if (readOnly) {
      return;
    }
    controller.redo();
    return;
  }
  if (readOnly) {
    return;
  }
  const step = controller.display.gridSize > 0 ? controller.display.gridSize : 1;
  const distance = event.shiftKey ? step * 10 : step;
  const deltas: Readonly<Record<string, Point>> = {
    ArrowLeft: { x: -distance, y: 0 },
    ArrowRight: { x: distance, y: 0 },
    ArrowUp: { x: 0, y: -distance },
    ArrowDown: { x: 0, y: distance },
  };
  const delta = deltas[event.key];
  if (delta !== undefined) {
    event.preventDefault();
    context.deps.run(() => controller.moveSelectionBy(delta.x, delta.y));
  }
}
