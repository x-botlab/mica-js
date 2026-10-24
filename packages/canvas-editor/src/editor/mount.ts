import type { CanvasBindingTarget, CanvasCommand, CanvasDocument } from '@mica-js/core/canvas';
import type { WidgetHost, WidgetPublish } from '@mica-js/widget';
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

export interface CreateCanvasEditorOptions {
  /** Caller-provided container; the editor only appends and removes its own root. */
  readonly container: HTMLElement;
  /** Parsed `.cnv` document; parse text with `parseCanvas` before handing it over. */
  readonly document: CanvasDocument;
  /** Runtime built by the host (see x-botlab/mica-js#118); the editor never owns it. */
  readonly host: WidgetHost;
  /** Defaults to `'edit'`. */
  readonly mode?: CanvasMode;
  /** Called after every committed document change, so the host can persist the `.cnv`. */
  readonly onChange?: (document: CanvasDocument) => void;
  readonly onSelectionChange?: (ids: readonly string[]) => void;
  readonly onDiagnostic?: (diagnostic: CanvasEditorDiagnostic) => void;
  readonly theme?: Partial<CanvasTheme>;
}

/** A widget publish resolved back to the endpoint it was bound to. */
export type CanvasEditorPublishListener = (
  target: CanvasBindingTarget,
  payload: unknown,
  simTime: number,
) => void;

export interface CanvasEditor {
  /** Snapshot the editor currently draws; the same reference until a command commits a new one. */
  getDocument(): CanvasDocument;
  /** Mode in effect; every call returns the current value. */
  getMode(): CanvasMode;
  /**
   * Switches mode and resets every widget: the host rebuilds its instances from the current
   * document, so widgets restart from their initial state.
   *
   * `getMode()` reflects the new value immediately, because input routing has to follow at once;
   * the returned promise resolves once `host.reset()` has remounted every instance. Switching to
   * the mode already in effect resolves without resetting. Selection and viewport survive, because
   * the document — and therefore every instance id — is unchanged.
   *
   * @throws when the host rejects the reset; the editor then reverts to the previous mode.
   */
  setMode(mode: CanvasMode): Promise<void>;
  /**
   * Replaces the editor selection, e.g. from a host-side layer list.
   *
   * The editor reports the change through `onSelectionChange`; ids the document does not contain
   * are dropped, so a stale id can never leave a selection the editor cannot draw.
   */
  setSelection(ids: readonly string[]): void;
  /** Drops the gesture in flight without producing a command. */
  cancelInteraction(): void;
  /** Current viewport and selection, for the host to persist or inspect. */
  getState(): CanvasEditorState;
  /** Simulation side → widgets: forwards to every instance bound to `target`. */
  deliver(target: CanvasBindingTarget, payload: unknown, simTime: number): void;
  /** Widget → simulation side; the returned function unsubscribes. */
  onPublish(listener: CanvasEditorPublishListener): () => void;
  /**
   * Feeds one publish of a host created with `WidgetHostOptions.onPublish`; hosts that offer a
   * publish subscription hand their payloads over through it automatically.
   */
  receivePublish(publish: WidgetPublish): void;
  focus(): void;
  /** Tears the editor down and releases its subscriptions; the host is left untouched. */
  destroy(): void;
}

/**
 * `WidgetHost` plus the publish subscription some hosts offer. `WidgetHostOptions.onPublish` is
 * the only publish hook of a real host and it accepts exactly one callback, so a host that keeps
 * it at construction time forwards to {@link CanvasEditor.receivePublish} instead.
 */
interface PublishingWidgetHost extends WidgetHost {
  onPublish?(listener: (publish: WidgetPublish) => void): () => void;
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

/**
 * Mounts the editor over a loaded document and wires it to the widget host: commands go down,
 * snapshots come back, and publishes are resolved to their bound endpoints.
 *
 * @throws {SchematicError} when the host rejects `options.document`; no editor is mounted then.
 */
export async function createCanvasEditor(
  options: CreateCanvasEditorOptions,
): Promise<CanvasEditor> {
  const { host } = options;
  await host.loadDocument(options.document);

  let snapshot: CanvasDocument = host.getDocument();
  let mode: CanvasMode = options.mode ?? 'edit';
  let destroyed = false;
  let unsubscribeHostPublish: (() => void) | undefined;
  const publishListeners = new Set<CanvasEditorPublishListener>();

  const elementDocument = options.container.ownerDocument;
  const view = elementDocument.defaultView;
  const theme = resolveCanvasTheme(options.theme);

  const session = new CanvasInteractionSession({
    mode,
    viewport: { x: 0, y: 0, scale: 1 },
  });
  // The host owns the layer store for its whole lifetime, so one lookup is enough.
  const layers = host.getLayers();
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
   * added/removed), an adopted host snapshot, `setMode` / `setSelection` / `cancelInteraction`,
   * every interaction step that reports `redraw` (pan, zoom, drag/resize/rotate preview, selection
   * change), and container resizes. An idle editor therefore holds no `requestAnimationFrame`.
   */
  function invalidate(): void {
    if (destroyed) {
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
      if (destroyed || !dirty) {
        return;
      }
      dirty = false;
      draw();
    });
  }

  function draw(): void {
    renderer.render({
      document: snapshot,
      layers,
      previews: session.previews,
      selection: session.selection,
      viewport: session.viewport,
      mode: session.mode,
    });
  }

  function resize(): void {
    if (destroyed) {
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
      applyHostCommand(command);
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
      host.dispatch(forwarded.instanceId, forwarded.event);
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
    if (destroyed) {
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
        snapshot,
        session.selection,
        session.viewport,
        documentPoint,
      );
      if (handle !== undefined) {
        cursor = CURSORS[handle.handle];
      } else if (hitTestTopmost(snapshot.widgets, documentPoint) !== undefined) {
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
    if (destroyed) {
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
    applyResult(session.pointerDown(snapshot, toPointerInput(event)));
    updateCursor(event);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (destroyed) {
      return;
    }
    applyResult(session.pointerMove(snapshot, toPointerInput(event)));
    updateCursor(event);
  }

  function handlePointerUp(event: PointerEvent): void {
    if (destroyed) {
      return;
    }
    releasePointer(event.pointerId);
    applyResult(session.pointerUp(snapshot, toPointerInput(event)));
    updateCursor(event);
  }

  function handlePointerCancel(event: PointerEvent): void {
    if (destroyed) {
      return;
    }
    releasePointer(event.pointerId);
    applyResult(session.pointerCancel(snapshot, toPointerInput(event)));
    updateCursor();
  }

  function handleWheel(event: WheelEvent): void {
    if (destroyed) {
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
    if (destroyed) {
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
    applyResult(session.keyDown(snapshot, toKeyInput(event)));
  }

  function handleKeyUp(event: KeyboardEvent): void {
    if (destroyed) {
      return;
    }
    if (event.key === ' ' || event.code === 'Space') {
      spaceHeld = false;
      updateCursor();
    }
    applyResult(session.keyUp(snapshot, toKeyInput(event)));
  }

  function handleBlur(): void {
    if (destroyed) {
      return;
    }
    if (spaceHeld) {
      spaceHeld = false;
      updateCursor();
    }
    // A pointer that is lost (window switch, stolen capture) must never leave a gesture stuck: the
    // cancel drops the preview without a command and releases the pointer for the next press.
    applyResult(session.pointerCancel(snapshot));
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

  const unsubscribeLayers = layers.subscribe(() => {
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

  /**
   * Makes `next` the snapshot the editor draws. The reference check is what keeps a command from
   * being adopted twice: the host notifies `onDocumentChange` synchronously, and the command
   * handler adopts `host.getDocument()` afterwards.
   */
  function adopt(next: CanvasDocument): void {
    if (destroyed || next === snapshot) {
      return;
    }
    snapshot = next;
    invalidate();
    if (options.onChange === undefined) {
      return;
    }
    try {
      options.onChange(next);
    } catch (error) {
      report({
        code: 'canvas-editor/change-failed',
        message: 'onChange threw.',
        cause: error,
      });
    }
  }

  function applyHostCommand(command: CanvasCommand): void {
    if (destroyed) {
      return;
    }
    try {
      host.applyCommand(command);
    } catch (error) {
      // The host kept its old snapshot, so the editor must keep drawing it.
      report({
        code: 'canvas-editor/command-failed',
        message: `The host rejected "${command.type}": ${describeError(error)}`,
        cause: error,
      });
      return;
    }
    adopt(host.getDocument());
  }

  function deliver(target: CanvasBindingTarget, payload: unknown, simTime: number): void {
    if (destroyed) {
      return;
    }
    for (const instance of snapshot.widgets) {
      const bindings = instance.bindings;
      if (bindings === undefined) {
        continue;
      }
      for (const port of Object.keys(bindings)) {
        const bound = bindings[port];
        if (bound === undefined || bound.symbol !== target.symbol || bound.port !== target.port) {
          continue;
        }
        host.deliver(instance.id, port, payload, simTime);
      }
    }
  }

  function receivePublish(publish: WidgetPublish): void {
    if (destroyed) {
      return;
    }
    const target = snapshot.widgets.find((instance) => instance.id === publish.instanceId)
      ?.bindings?.[publish.port];
    if (target === undefined) {
      report({
        code: 'canvas-editor/unbound-publish',
        instanceId: publish.instanceId,
        message: `Instance "${publish.instanceId}" published "${publish.port}", which has no binding.`,
      });
      return;
    }
    for (const listener of [...publishListeners]) {
      try {
        listener(target, publish.payload, publish.simTime);
      } catch (error) {
        report({
          code: 'canvas-editor/publish-failed',
          message: 'A publish listener threw.',
          instanceId: publish.instanceId,
          cause: error,
        });
      }
    }
  }

  function applyMode(next: CanvasMode): void {
    if (destroyed || session.mode === next) {
      return;
    }
    session.setMode(next);
    updateCursor();
    invalidate();
  }

  async function setMode(next: CanvasMode): Promise<void> {
    if (destroyed || next === mode) {
      return;
    }
    const previous = mode;
    // A gesture started in the old mode must not spill a command into the new one.
    cancelInteraction();
    applyMode(next);
    // Routed input follows the new mode right away, even while the widgets are still remounting.
    mode = next;
    try {
      await host.reset();
    } catch (error) {
      if (destroyed) {
        return;
      }
      // The widgets were not rebuilt, so keep the editor on the mode they are actually running in.
      mode = previous;
      applyMode(previous);
      throw error;
    }
  }

  function setSelection(ids: readonly string[]): void {
    if (destroyed) {
      return;
    }
    const known = new Set(snapshot.widgets.map((widget) => widget.id));
    session.setSelection(ids.filter((id) => known.has(id)));
    emitSelection();
    invalidate();
  }

  function cancelInteraction(): void {
    if (destroyed) {
      return;
    }
    session.cancelInteraction();
    invalidate();
  }

  function onPublish(listener: CanvasEditorPublishListener): () => void {
    if (destroyed) {
      return () => {};
    }
    publishListeners.add(listener);
    return () => {
      publishListeners.delete(listener);
    };
  }

  function getState(): CanvasEditorState {
    const viewport = session.viewport;
    return {
      mode: session.mode,
      selection: [...session.selection],
      viewport: { x: viewport.x, y: viewport.y, scale: viewport.scale },
    };
  }

  function focus(): void {
    if (destroyed) {
      return;
    }
    canvas.focus({ preventScroll: true });
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    if (frame !== 0) {
      view?.cancelAnimationFrame(frame);
      frame = 0;
    }
    unsubscribeLayers();
    unsubscribeDocumentChange();
    unsubscribeHostPublish?.();
    publishListeners.clear();
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
  }

  const unsubscribeDocumentChange = host.onDocumentChange(adopt);

  // `WidgetHost` has no publish subscription; a host that offers one is wired here, and the rest
  // of the world forwards through `receivePublish`.
  const publishHost = host as PublishingWidgetHost;
  if (typeof publishHost.onPublish === 'function') {
    unsubscribeHostPublish = publishHost.onPublish(receivePublish);
  }

  return {
    getDocument(): CanvasDocument {
      return snapshot;
    },
    getMode(): CanvasMode {
      return mode;
    },
    setMode,
    setSelection,
    cancelInteraction,
    getState,
    deliver,
    onPublish,
    receivePublish,
    focus,
    destroy,
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
