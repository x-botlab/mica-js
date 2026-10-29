import type { Point } from '@mica-js/core/schematic';
import type { InteractionContext } from './context';
import { rotatePlacement } from './placement';
import { finishWire } from './wire';

/**
 * Cancels whatever interaction is pending: placement, the wire being drawn, a drag or the active
 * tool, and clears the selection. Returns whether there was anything to cancel.
 */
export function cancelInteraction(context: InteractionContext): boolean {
  const editor = context.deps.editor;
  const active =
    editor.getPlacingDevice() !== undefined ||
    editor.getTool() !== 'select' ||
    editor.getSelection().length > 0 ||
    context.state.pendingWire.length > 0 ||
    context.state.drag !== undefined;
  if (!active) {
    return false;
  }
  if (editor.getPlacingDevice() !== undefined) {
    editor.cancelPlacement();
  }
  context.state.reset();
  editor.setSelection([]);
  editor.setTool('select');
  context.deps.onChange();
  return true;
}

/** Keyboard shortcuts; the canvas keeps focus, so the root element owns the listener. */
export function handleKeyDown(context: InteractionContext, event: KeyboardEvent): void {
  const editor = context.deps.editor;
  const readOnly = context.deps.readOnly;

  // Host controls (property fields, search boxes) bubble their keys here; leave them alone.
  if (isEditableTarget(event.target)) {
    return;
  }

  if (event.key === ' ') {
    event.preventDefault();
    if (rotatePlacement(context, 90)) {
      return;
    }
    if (!readOnly) {
      context.deps.run(() => editor.rotateSelection(90));
    }
    return;
  }
  if (event.key === 'Escape') {
    cancelInteraction(context);
    return;
  }
  if (event.key === 'Enter') {
    if (editor.getTool() === 'wire') {
      finishWire(context);
    }
    return;
  }
  if (
    event.key === 'Backspace' &&
    editor.getTool() === 'wire' &&
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
      context.deps.run(() => editor.deleteSelection());
    }
    return;
  }
  if (event.key === 'r' || event.key === 'R') {
    if (!readOnly) {
      context.deps.run(() => editor.rotateSelection(90));
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
      editor.redo();
    } else {
      editor.undo();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
    event.preventDefault();
    if (readOnly) {
      return;
    }
    editor.redo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    editor.selectAll();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'd' || event.key === 'D')) {
    // The browser would bookmark the page; the editor duplicates the selection instead.
    event.preventDefault();
    if (!readOnly) {
      editor.duplicateSelection();
    }
    return;
  }
  if (readOnly) {
    return;
  }
  const step = editor.getDisplay().gridSize > 0 ? editor.getDisplay().gridSize : 1;
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
    context.deps.run(() => editor.moveSelectionBy(delta.x, delta.y));
  }
}

/** Text fields and contenteditable hosts keep their own shortcuts. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') {
    return false;
  }
  const element = target as { readonly tagName?: unknown; readonly isContentEditable?: unknown };
  const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
  return tagName === 'input' || tagName === 'textarea' || element.isContentEditable === true;
}
