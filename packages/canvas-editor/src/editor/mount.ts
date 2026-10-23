import type { CanvasCommand, CanvasDocument } from '@mica-js/core/canvas';
import type { WidgetInputEvent, WidgetLayers } from '@mica-js/widget';
import { hitTestTopmost, type CanvasHandle } from '../geometry';
import { CanvasFrameRenderer } from '../render/renderer';
import {
  CanvasInteractionSession,
  handleUnderPointer,
  type ForwardedInput,
  type InteractionResult,
  type KeyInput,
  type PointerInput,
} from '../session';
import { CANVAS_EDITOR_STYLES } from '../styles';
import { resolveCanvasTheme, type CanvasTheme } from '../theme';
import type { CanvasEditorDiagnostic, CanvasEditorState, CanvasMode } from '../types';
import { screenToDocument } from '../viewport';

export interface MountCanvasEditorOptions {
  /** Caller-provided container; the editor only appends and removes its own root. */
  readonly container: HTMLElement;
  /** Current document snapshot; the host feeds a new one after applying a command. */
  readonly document: CanvasDocument;
  /** Frames of the mounted widgets, composited in `list()` order. */
  readonly layers: WidgetLayers;
  /** Defaults to `'edit'`. */
  readonly mode?: CanvasMode;
  /** Commands produced by an edit; the editor never modifies the document itself. */
  readonly onCommand?: (command: CanvasCommand) => void;
  readonly onSelectionChange?: (ids: readonly string[]) => void;
  /** Run-mode input that hit an instance, in instance-local logical units. */
  readonly dispatch?: (instanceId: string, event: WidgetInputEvent) => void;
  readonly onDiagnostic?: (diagnostic: CanvasEditorDiagnostic) => void;
  readonly theme?: Partial<CanvasTheme>;
}

export interface CanvasEditor {
  /** Feeds the snapshot produced by applying a command; selection, viewport and gestures survive. */
  setDocument(document: CanvasDocument): void;
  setMode(mode: CanvasMode): void;
  setSelection(ids: readonly string[]): void;
  /** Drops the gesture in flight without producing a command. */
  cancelInteraction(): void;
  /** Current viewport and selection, for the host to persist or inspect. */
  getState(): CanvasEditorState;
  focus(): void;
  destroy(): void;
}

const CURSORS: Readonly<Record<CanvasHandle, string>> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  rotate: 'crosshair',
};

/** Mounts a canvas editor inside `options.container`. */
export function mountCanvasEditor(options: MountCanvasEditorOptions): CanvasEditor {
  const elementDocument = options.container.ownerDocument;
  const view = elementDocument.defaultView;
  const theme = resolveCanvasTheme(options.theme);

  const session = new CanvasInteractionSession({
    mode: options.mode ?? 'edit',
    viewport: { x: 0, y: 0, scale: 1 },
  });
  let currentDocument = options.document;
  let disposed = false;
  let spaceHeld = false;
  let lastSelection: readonly string[] = [];
  let frame = 0;
  let dirty = false;

  const root = elementDocument.createElement('div');
  root.className = 'mica-canvas-editor';
  root.style.background = theme.background;
  const styleElement = elementDocument.createElement('style');
  styleElement.textContent = CANVAS_EDITOR_STYLES;
  const canvas = elementDocument.createElement('canvas');
  canvas.className = 'mica-canvas-editor__surface';
  canvas.tabIndex = 0;
  root.append(styleElement, canvas);

  const renderer = new CanvasFrameRenderer({ canvas, theme, onDiagnostic: report });
  // Browsers must not pan the page while the pointer moves across the canvas.
  const previousTouchAction = options.container.style.touchAction;
  options.container.style.touchAction = 'none';

  /**
   * Marks the canvas dirty and schedules at most one repaint per animation frame.
   *
   * Triggers, and the only triggers: `layers.subscribe` (a widget produced a frame, or a layer was
   * added/removed), `setDocument` / `setMode` / `setSelection` / `cancelInteraction`, every
   * interaction step that reports `redraw` (pan, zoom, drag/resize/rotate preview, selection
   * change), and container resizes. An idle editor therefore holds no `requestAnimationFrame`.
   */
  function invalidate(): void {
    if (disposed) {
      return;
    }
    dirty = true;
    if (frame !== 0) {
      return;
    }
    if (view === null) {
      draw();
      return;
    }
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (disposed || !dirty) {
        return;
      }
      dirty = false;
      draw();
    });
  }

  function draw(): void {
    renderer.render({
      document: currentDocument,
      layers: options.layers,
      previews: session.previews,
      selection: session.selection,
      viewport: session.viewport,
      mode: session.mode,
    });
  }

  function resize(): void {
    if (disposed) {
      return;
    }
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    renderer.resize(width, height, view?.devicePixelRatio ?? 1);
    invalidate();
  }

  function report(diagnostic: CanvasEditorDiagnostic): void {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // A throwing diagnostic sink must not break input handling.
    }
  }

  function emitSelection(): void {
    const selection = session.selection;
    if (sameIds(selection, lastSelection)) {
      return;
    }
    lastSelection = [...selection];
    try {
      options.onSelectionChange?.(lastSelection);
    } catch (error) {
      report({
        code: 'canvas-editor/selection-failed',
        message: 'onSelectionChange threw.',
        cause: error,
      });
    }
  }

  function applyResult(result: InteractionResult): void {
    for (const command of result.commands) {
      try {
        options.onCommand?.(command);
      } catch (error) {
        report({
          code: 'canvas-editor/command-failed',
          message: `onCommand threw while handling "${command.type}".`,
          cause: error,
        });
      }
    }
    for (const forwarded of result.events) {
      forward(forwarded);
    }
    emitSelection();
    if (result.redraw) {
      invalidate();
    }
  }

  function forward(forwarded: ForwardedInput): void {
    try {
      options.dispatch?.(forwarded.instanceId, forwarded.event);
    } catch (error) {
      report({
        code: 'canvas-editor/dispatch-failed',
        message: `dispatch threw for instance "${forwarded.instanceId}".`,
        instanceId: forwarded.instanceId,
        cause: error,
      });
    }
  }

  function updateCursor(event?: { readonly clientX: number; readonly clientY: number }): void {
    if (disposed) {
      return;
    }
    if (session.interaction === 'panning') {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (spaceHeld) {
      canvas.style.cursor = 'grab';
      return;
    }
    if (session.mode === 'run') {
      canvas.style.cursor = 'default';
      return;
    }
    let cursor = 'default';
    if (event !== undefined) {
      const screenPoint = toCanvasPoint(event);
      const documentPoint = screenToDocument(session.viewport, screenPoint);
      const handle = handleUnderPointer(
        currentDocument,
        session.selection,
        session.viewport,
        documentPoint,
      );
      if (handle !== undefined) {
        cursor = CURSORS[handle.handle];
      } else if (hitTestTopmost(currentDocument.widgets, documentPoint) !== undefined) {
        cursor = 'move';
      }
    }
    canvas.style.cursor = cursor;
  }

  function toCanvasPoint(event: { readonly clientX: number; readonly clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function toPointerInput(event: PointerEvent): PointerInput {
    const point = toCanvasPoint(event);
    return {
      x: point.x,
      y: point.y,
      button: event.button,
      buttons: event.buttons,
      pointerId: event.pointerId,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey || event.metaKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      spaceKey: spaceHeld,
    };
  }

  function toKeyInput(event: KeyboardEvent): KeyInput {
    return {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    };
  }

  function capturePointer(pointerId: number): void {
    if (canvas.hasPointerCapture(pointerId)) {
      return;
    }
    canvas.setPointerCapture(pointerId);
  }

  function releasePointer(pointerId: number): void {
    if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  }

  function handlePointerDown(event: PointerEvent): void {
    if (disposed) {
      return;
    }
    canvas.focus({ preventScroll: true });
    if (event.button === 1) {
      // Middle-button panning would otherwise start autoscroll.
      event.preventDefault();
    }
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) {
      return;
    }
    capturePointer(event.pointerId);
    applyResult(session.pointerDown(currentDocument, toPointerInput(event)));
    updateCursor(event);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (disposed) {
      return;
    }
    applyResult(session.pointerMove(currentDocument, toPointerInput(event)));
    updateCursor(event);
  }

  function handlePointerUp(event: PointerEvent): void {
    if (disposed) {
      return;
    }
    releasePointer(event.pointerId);
    applyResult(session.pointerUp(currentDocument, toPointerInput(event)));
    updateCursor(event);
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (disposed) {
      return;
    }
    releasePointer(event.pointerId);
    applyResult(session.pointerCancel(currentDocument, toPointerInput(event)));
    updateCursor();
  }

  function handleWheel(event: WheelEvent): void {
    if (disposed) {
      return;
    }
    event.preventDefault();
    const point = toCanvasPoint(event);
    applyResult(
      session.wheel({
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        // Firefox reports lines and some devices pages; the session normalizes both to pixels.
        deltaMode: event.deltaMode,
        pageSize: canvas.clientHeight,
        shiftKey: event.shiftKey,
      }),
    );
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (disposed) {
      return;
    }
    // Space is the pan modifier in both modes, so it must never scroll the page. Edit mode keeps
    // it away from the widgets; run mode still forwards the key after registering the modifier.
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      spaceHeld = true;
      updateCursor();
      if (session.mode === 'edit') {
        return;
      }
    }
    if (session.mode === 'edit' && ownsKey(event)) {
      event.preventDefault();
    }
    applyResult(session.keyDown(currentDocument, toKeyInput(event)));
  }

  function handleKeyUp(event: KeyboardEvent): void {
    if (disposed) {
      return;
    }
    if (event.key === ' ' || event.code === 'Space') {
      spaceHeld = false;
      updateCursor();
    }
    applyResult(session.keyUp(currentDocument, toKeyInput(event)));
  }

  function handleBlur(): void {
    if (disposed) {
      return;
    }
    if (spaceHeld) {
      spaceHeld = false;
      updateCursor();
    }
    // A pointer that is lost (window switch, stolen capture) must never leave a gesture stuck: the
    // cancel drops the preview without a command and releases the pointer for the next press.
    applyResult(session.pointerCancel(currentDocument));
  }

  const preventDefault = (event: Event): void => {
    event.preventDefault();
  };

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerCancel);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('keydown', handleKeyDown);
  canvas.addEventListener('keyup', handleKeyUp);
  canvas.addEventListener('blur', handleBlur);
  canvas.addEventListener('contextmenu', preventDefault);
  canvas.addEventListener('dragstart', preventDefault);
  view?.addEventListener('blur', handleBlur);

  const unsubscribeLayers = options.layers.subscribe(() => {
    invalidate();
  });

  const ResizeObserverConstructor = view?.ResizeObserver;
  const observer =
    ResizeObserverConstructor === undefined
      ? undefined
      : new ResizeObserverConstructor(() => {
          resize();
        });
  observer?.observe(root);

  options.container.append(root);
  resize();

  return {
    setDocument(next: CanvasDocument): void {
      if (disposed) {
        return;
      }
      currentDocument = next;
      invalidate();
    },
    setMode(next: CanvasMode): void {
      if (disposed || session.mode === next) {
        return;
      }
      // A gesture started in another mode must not spill commands into the new one.
      session.cancelInteraction();
      session.setMode(next);
      updateCursor();
      invalidate();
    },
    setSelection(ids: readonly string[]): void {
      if (disposed) {
        return;
      }
      session.setSelection(ids);
      emitSelection();
      invalidate();
    },
    cancelInteraction(): void {
      if (disposed) {
        return;
      }
      session.cancelInteraction();
      invalidate();
    },
    getState(): CanvasEditorState {
      const viewport = session.viewport;
      return {
        mode: session.mode,
        selection: [...session.selection],
        viewport: { x: viewport.x, y: viewport.y, scale: viewport.scale },
      };
    },
    focus(): void {
      if (disposed) {
        return;
      }
      canvas.focus({ preventScroll: true });
    },
    destroy(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (frame !== 0) {
        view?.cancelAnimationFrame(frame);
        frame = 0;
      }
      unsubscribeLayers();
      observer?.disconnect();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('keydown', handleKeyDown);
      canvas.removeEventListener('keyup', handleKeyUp);
      canvas.removeEventListener('blur', handleBlur);
      canvas.removeEventListener('contextmenu', preventDefault);
      canvas.removeEventListener('dragstart', preventDefault);
      view?.removeEventListener('blur', handleBlur);
      renderer.destroy();
      root.remove();
      options.container.style.touchAction = previousTouchAction;
    },
  };
}

function ownsKey(event: KeyboardEvent): boolean {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && (event.key === 'a' || event.key === 'A')) {
    return true;
  }
  return (
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === 'Delete' ||
    event.key === 'Backspace'
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
