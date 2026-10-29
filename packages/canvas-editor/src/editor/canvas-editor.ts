import type { CanvasBindingTarget, CanvasCommand, CanvasDocument } from '@mica-js/core/canvas';
import type { WidgetHost, WidgetLayers, WidgetPublish } from '@mica-js/widget';
import { hitTestTopmost, type CanvasHandle } from '../geometry';
import type { CanvasBindingTargetInfo, HostProvider } from '../host/provider';
import { CanvasFrameRenderer } from '../render/renderer';
import {
  CanvasInteractionSession,
  handleUnderPointer,
  type ForwardedInput,
  type InteractionResult,
  type KeyInput,
  type PointerInput,
} from '../session';
import { resolveCanvasTheme, type CanvasTheme } from '../theme';
import type { CanvasEditorDiagnostic, CanvasEditorState, CanvasMode } from '../types';
import { screenToDocument } from '../viewport';

/**
 * Stable public options contract for {@link CanvasEditor} and {@link createCanvasEditor}. Both
 * accept it as-is; the implementation keeps no additional constructor inputs.
 */
export interface CanvasEditorOptions {
  /** Caller-provided container; the editor only appends and removes its own root. */
  readonly container: HTMLElement;
  /** Parsed `.cnv` document; parse text with `parseCanvas` before handing it over. */
  readonly document: CanvasDocument;
  /**
   * Builds the widget runtime the editor drives, and owns it: the editor awaits
   * {@link HostProvider.createWidgetHost} while `ready` is pending and disposes the provider from
   * {@link CanvasEditor.dispose}. See `SandboxHostProvider` for the sandboxed implementation.
   */
  readonly hostProvider: HostProvider;
  /**
   * Creates the AudioWorkletNode when the editor's lazily created AudioContext first needs audio.
   * The callback receives the context owned by the editor.
   */
  readonly getAudioWorklet?: (context: AudioContext) => Promise<AudioWorkletNode>;
  /** Defaults to `'edit'`. Synchronized to the host before the initial document load. */
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
 * Construction is synchronous, host creation and the host document load are not: the constructor
 * creates the editor state and starts {@link CanvasEditor.ready}, which first asks
 * `options.hostProvider` for the host and then hands `options.document` to it. The root element,
 * the input listeners and the resize observer are only set up once the host accepted the document,
 * so a failing provider or a rejected document leaves the container untouched and `ready` rejects
 * with the provider's or host's error.
 */
export class CanvasEditor {
  /**
   * Settles after the provider built the host and `host.loadDocument(options.document)` resolved:
   * the editor is mounted over the snapshot the host holds, and it rejects when the provider could
   * not create a host or the host rejected the document. The editor never mounts then.
   */
  readonly ready: Promise<void>;

  readonly #options: CanvasEditorOptions;
  readonly #provider: HostProvider;
  /** Set once the provider created the host; every later step runs against it. */
  #host!: WidgetHost;
  #layers!: WidgetLayers;
  readonly #session: CanvasInteractionSession;
  readonly #publishListeners = new Set<CanvasEditorPublishListener>();

  /** `loading` while the host document loads; `failed` once the host rejected it. */
  #phase: 'loading' | 'ready' | 'failed' = 'loading';
  #snapshot: CanvasDocument;
  #mode: CanvasMode;
  #disposed = false;
  #mounted = false;
  #spaceHeld = false;
  #lastSelection: readonly string[] = [];
  #frame = 0;
  #dirty = false;
  /** Settles once the provider released the hosts; `undefined` until `dispose()` ran. */
  #disposal: Promise<void> | undefined;
  #audioContext: AudioContext | undefined;

  #view: (Window & typeof globalThis) | null = null;
  #root!: HTMLDivElement;
  #canvas!: HTMLCanvasElement;
  #renderer!: CanvasFrameRenderer;
  #observer: ResizeObserver | undefined;
  #previousTouchAction = '';
  #unsubscribeLayers: (() => void) | undefined;
  #unsubscribeDocumentChange: (() => void) | undefined;
  #unsubscribeHostPublish: (() => void) | undefined;

  constructor(options: CanvasEditorOptions) {
    this.#options = options;
    this.#provider = options.hostProvider;
    // Until the host answers, the editor draws the document it was handed.
    this.#snapshot = options.document;
    this.#mode = options.mode ?? 'edit';
    this.#session = new CanvasInteractionSession({
      mode: this.#mode,
      viewport: { x: 0, y: 0, scale: 1 },
    });
    this.ready = this.#initialize();
  }

  /** Snapshot the editor currently draws; the same reference until a commit replaces it. */
  getDocument(): CanvasDocument {
    return this.#snapshot;
  }

  /**
   * Applies one command to the current document, like a gesture that just finished.
   *
   * The host owns the document: it commits the command, reports the new snapshot through
   * `onDocumentChange` and `onChange` fires once. A command the host rejects is reported as
   * `canvas-editor/command-failed` and the editor keeps drawing the snapshot the host still holds.
   *
   * A command that arrives before {@link CanvasEditor.ready} settled is dropped, like a delivery
   * before the instances exist: the initial load commits its own snapshot anyway. Called on a
   * disposed editor, it does nothing.
   */
  applyCommand(command: CanvasCommand): void {
    if (this.#phase !== 'ready') {
      return;
    }
    this.#applyHostCommand(command);
  }

  /** Mode in effect; every call returns the current value. */
  getMode(): CanvasMode {
    return this.#mode;
  }

  /**
   * Switches mode and resets every widget: the host rebuilds its instances from the current
   * document, so widgets restart from their initial state.
   *
   * The host mode follows, because the host owns the clock: `WidgetHost.dispatch` queues input for
   * the next step start, and only simulation mode advances steps. An editor in simulation mode over
   * an edit-mode host would forward input nobody ever flushes and never tick the devices.
   *
   * `getMode()` reflects the new value immediately, because input routing has to follow at once;
   * the returned promise resolves once the host has remounted every instance. Switching to the mode
   * already in effect resolves without resetting. Selection and viewport survive, because the
   * document — and therefore every instance id — is unchanged.
   *
   * Called before {@link CanvasEditor.ready} settled, the switch waits for the document to load.
   *
   * @throws when the host rejects the switch; the editor then reverts to the previous mode.
   */
  async setMode(next: CanvasMode): Promise<void> {
    if (this.#disposed || next === this.#mode) {
      return;
    }
    if (this.#phase !== 'ready') {
      // A rejection here is the provider failing or the host rejecting `options.document`.
      await this.ready;
      if (this.#disposed || next === this.#mode) {
        return;
      }
    }
    const previous = this.#mode;
    // A gesture started in the old mode must not spill a command into the new one.
    this.cancelInteraction();
    this.#applyMode(next);
    // Routed input follows the new mode right away, even while the widgets are still remounting.
    this.#mode = next;
    try {
      // The host mode has to follow, because the frame clock — and with it every dispatched input —
      // hangs off it. `host.setMode` resets the devices and rebuilds every instance too, so only a
      // host that is already in `next` needs the plain restart.
      if (this.#host.getMode() === next) {
        await this.#host.reset();
      } else {
        await this.#host.setMode(next);
      }
    } catch (error) {
      if (this.#disposed) {
        return;
      }
      // The widgets were not rebuilt, so keep the editor on the mode they are actually running in.
      this.#mode = previous;
      this.#applyMode(previous);
      throw error;
    }
  }

  /**
   * Hands a new document to the host and draws the snapshot the host commits in its place.
   *
   * The host loads the document's schematic before it mounts any instance, so the returned promise
   * resolves once every instance of the new document is mounted. `onChange` fires for the committed
   * snapshot, exactly like a command commit. Selection ids the new document does not contain are
   * dropped; viewport and mode survive.
   *
   * Called before {@link CanvasEditor.ready} settled, the load waits for the initial document
   * first. Called on a disposed editor, it does nothing.
   *
   * @throws when the host rejects the document; the host then keeps its previous document and the
   * editor keeps drawing that snapshot, so the editor stays ready. A load abandoned through
   * `dispose()` resolves instead of rejecting.
   */
  async loadDocument(document: CanvasDocument): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#phase !== 'ready') {
      // A rejection here is the provider failing or the host rejecting `options.document`.
      await this.ready;
      if (this.#disposed) {
        return;
      }
    }
    // A gesture belongs to the document it started on; it must not commit into the new one.
    this.cancelInteraction();
    try {
      await this.#host.loadDocument(document);
    } catch (error) {
      // A load cut short by `dispose()` is not the caller's problem; the editor is already gone.
      if (this.#disposed) {
        return;
      }
      throw error;
    }
    if (this.#disposed) {
      return;
    }
    // A host reports the committed snapshot through `onDocumentChange`; adopt it here as well, so
    // a host that only answers `getDocument()` still lands on the canvas.
    this.#adopt(this.#host.getDocument());
    this.#pruneSelection();
  }

  /**
   * Endpoints the loaded schematic offers, in the shape a binding picker lists them.
   *
   * The provider answers from the device host it owns, so callers never reach for that host.
   * Awaits {@link CanvasEditor.ready}, so a call made while the first document is still loading
   * answers with the endpoints of that document's schematic. Every call re-reads the live devices,
   * so await {@link CanvasEditor.loadDocument} first when the new document binds another schematic.
   *
   * Resolves with an empty list on a disposed editor.
   *
   * @throws when the provider could not create the host or the host rejected the document, exactly
   * like `ready`.
   */
  async getBindingTargets(): Promise<readonly CanvasBindingTargetInfo[]> {
    if (this.#disposed) {
      return [];
    }
    await this.ready;
    if (this.#disposed) {
      return [];
    }
    return this.#provider.getBindingTargets();
  }

  /**
   * Replaces the editor selection, e.g. from a host-side layer list.
   *
   * The editor reports the change through `onSelectionChange`; ids the document does not contain
   * are dropped, so a stale id can never leave a selection the editor cannot draw.
   */
  setSelection(ids: readonly string[]): void {
    if (this.#disposed) {
      return;
    }
    const known = new Set(this.#snapshot.widgets.map((widget) => widget.id));
    this.#session.setSelection(ids.filter((id) => known.has(id)));
    this.#emitSelection();
    this.#invalidate();
  }

  /** Drops selection ids the committed document does not contain. */
  #pruneSelection(): void {
    const selection = this.#session.selection;
    const known = new Set(this.#snapshot.widgets.map((widget) => widget.id));
    const kept = selection.filter((id) => known.has(id));
    if (kept.length === selection.length) {
      return;
    }
    this.#session.setSelection(kept);
    this.#emitSelection();
    this.#invalidate();
  }

  /** Drops the gesture in flight without producing a command. */
  cancelInteraction(): void {
    if (this.#disposed) {
      return;
    }
    this.#session.cancelInteraction();
    this.#invalidate();
  }

  /** Current viewport and selection, for the host to persist or inspect. */
  getState(): CanvasEditorState {
    const viewport = this.#session.viewport;
    return {
      mode: this.#session.mode,
      selection: [...this.#session.selection],
      viewport: { x: viewport.x, y: viewport.y, scale: viewport.scale },
    };
  }

  /**
   * Simulation side → widgets: forwards to every instance bound to `target`.
   *
   * Deliveries need a host, so one that arrives before the provider created it — i.e. before
   * {@link CanvasEditor.ready} settled — is dropped; the instances do not exist yet either.
   */
  deliver(target: CanvasBindingTarget, payload: unknown, simTime: number): void {
    if (this.#disposed || this.#phase !== 'ready') {
      return;
    }
    for (const instance of this.#snapshot.widgets) {
      const bindings = instance.bindings;
      if (bindings === undefined) {
        continue;
      }
      for (const port of Object.keys(bindings)) {
        const bound = bindings[port];
        if (bound === undefined || bound.symbol !== target.symbol || bound.port !== target.port) {
          continue;
        }
        this.#host.deliver(instance.id, port, payload, simTime);
      }
    }
  }

  /** Widget → simulation side; the returned function unsubscribes. */
  onPublish(listener: CanvasEditorPublishListener): () => void {
    if (this.#disposed) {
      return () => {};
    }
    this.#publishListeners.add(listener);
    return () => {
      this.#publishListeners.delete(listener);
    };
  }

  /**
   * Feeds one publish of a host created with `WidgetHostOptions.onPublish`; hosts that offer a
   * publish subscription hand their payloads over through it automatically.
   */
  receivePublish(publish: WidgetPublish): void {
    if (this.#disposed) {
      return;
    }
    const target = this.#snapshot.widgets.find((instance) => instance.id === publish.instanceId)
      ?.bindings?.[publish.port];
    if (target === undefined) {
      this.#report({
        code: 'canvas-editor/unbound-publish',
        instanceId: publish.instanceId,
        message: `Instance "${publish.instanceId}" published "${publish.port}", which has no binding.`,
      });
      return;
    }
    for (const listener of [...this.#publishListeners]) {
      try {
        listener(target, publish.payload, publish.simTime);
      } catch (error) {
        this.#report({
          code: 'canvas-editor/publish-failed',
          message: 'A publish listener threw.',
          instanceId: publish.instanceId,
          cause: error,
        });
      }
    }
  }

  focus(): void {
    if (this.#disposed || !this.#mounted) {
      return;
    }
    this.#canvas.focus({ preventScroll: true });
  }

  /**
   * Tears the editor down, releases its subscriptions and disposes the host provider, so the hosts
   * and sandboxes the provider created go away with the editor.
   *
   * The DOM teardown is synchronous — the container is clean when this method returns — while the
   * provider is disposed in the background: the returned promise settles once it finished and never
   * rejects, because a failing teardown is reported as `canvas-editor/dispose-failed`. Callers that
   * ignore the promise still get a fully unmounted editor. Every call returns the same promise, so
   * disposing twice is safe.
   */
  dispose(): Promise<void> {
    if (this.#disposal !== undefined) {
      return this.#disposal;
    }
    this.#disposed = true;
    if (this.#frame !== 0) {
      this.#view?.cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
    this.#unsubscribeLayers?.();
    this.#unsubscribeDocumentChange?.();
    this.#unsubscribeHostPublish?.();
    this.#unsubscribeLayers = undefined;
    this.#unsubscribeDocumentChange = undefined;
    this.#unsubscribeHostPublish = undefined;
    this.#publishListeners.clear();
    if (this.#mounted) {
      this.#mounted = false;
      this.#observer?.disconnect();
      this.#observer = undefined;
      this.#detachListeners();
      this.#renderer.destroy();
      this.#root.remove();
      this.#options.container.style.touchAction = this.#previousTouchAction;
    }
    this.#disposal = this.#disposeHosts();
    return this.#disposal;
  }

  async #disposeHosts(): Promise<void> {
    // The provider may still be creating the host, or the host may still be loading the document;
    // either way `ready` settles first, and a host nobody used is torn down by the provider.
    await this.ready.catch(() => undefined);
    try {
      await this.#provider.dispose();
    } catch (error) {
      this.#report({
        code: 'canvas-editor/dispose-failed',
        message: `Disposing the host provider failed: ${describeError(error)}`,
        cause: error,
      });
    } finally {
      await this.#closeAudioContext();
    }
  }

  async #closeAudioContext(): Promise<void> {
    const context = this.#audioContext;
    this.#audioContext = undefined;
    if (context === undefined) return;
    try {
      await context.close();
    } catch (error) {
      this.#report({
        code: 'canvas-editor/dispose-failed',
        message: `Closing the audio context failed: ${describeError(error)}`,
        cause: error,
      });
    }
  }

  async #initialize(): Promise<void> {
    let host: WidgetHost;
    try {
      const getAudioWorklet = this.#options.getAudioWorklet;
      const audioContext =
        getAudioWorklet === undefined
          ? undefined
          : (() => {
              const AudioContextConstructor = globalThis.AudioContext;
              if (typeof AudioContextConstructor !== 'function') {
                throw new Error('CanvasEditor audio requires AudioContext.');
              }
              const context = new AudioContextConstructor();
              this.#audioContext = context;
              return context;
            })();
      host = await this.#provider.createWidgetHost(
        audioContext === undefined || getAudioWorklet === undefined
          ? undefined
          : { audio: { context: audioContext, getAudioWorklet } },
      );
    } catch (error) {
      this.#phase = 'failed';
      await this.#closeAudioContext();
      throw error;
    }
    if (this.#disposed) {
      // The provider produced a host nobody will drive; `dispose()` disposes it with the provider.
      return;
    }
    this.#host = host;
    // The host owns the layer store for its whole lifetime, so one lookup is enough.
    this.#layers = host.getLayers();
    try {
      if (host.getMode() !== this.#mode) {
        await host.setMode(this.#mode);
        if (this.#disposed) {
          return;
        }
      }
      await host.loadDocument(this.#options.document);
    } catch (error) {
      this.#phase = 'failed';
      throw error;
    }
    this.#phase = 'ready';
    if (this.#disposed) {
      return;
    }
    // The host accepted the document; its snapshot is the one every later commit is based on.
    this.#snapshot = host.getDocument();
    this.#mount();
  }

  #mount(): void {
    const { container, theme } = this.#options;
    const elementDocument = container.ownerDocument;
    this.#view = elementDocument.defaultView;
    const resolvedTheme = resolveCanvasTheme(theme);

    const root = elementDocument.createElement('div');
    root.className = 'mica-canvas-editor';
    root.style.background = resolvedTheme.background;
    const canvas = elementDocument.createElement('canvas');
    canvas.className = 'mica-canvas-editor__surface';
    canvas.tabIndex = 0;
    root.append(canvas);

    this.#root = root;
    this.#canvas = canvas;
    this.#renderer = new CanvasFrameRenderer({
      canvas,
      theme: resolvedTheme,
      onDiagnostic: (diagnostic) => this.#report(diagnostic),
    });
    // Browsers must not pan the page while the pointer moves across the canvas.
    this.#previousTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';
    this.#mounted = true;
    this.#attachListeners();

    this.#unsubscribeLayers = this.#layers.subscribe(() => {
      this.#invalidate();
    });

    const ResizeObserverConstructor = this.#view?.ResizeObserver;
    this.#observer =
      ResizeObserverConstructor === undefined
        ? undefined
        : new ResizeObserverConstructor(() => {
            this.#resize();
          });
    this.#observer?.observe(root);

    container.append(root);
    this.#resize();

    this.#unsubscribeDocumentChange = this.#host.onDocumentChange((document) => {
      this.#adopt(document);
    });

    // `WidgetHost` has no publish subscription; a host that offers one is wired here, and the rest
    // of the world forwards through `receivePublish`.
    const publishHost = this.#host as PublishingWidgetHost;
    if (typeof publishHost.onPublish === 'function') {
      this.#unsubscribeHostPublish = publishHost.onPublish((publish) => {
        this.receivePublish(publish);
      });
    }
  }

  #attachListeners(): void {
    const canvas = this.#canvas;
    canvas.addEventListener('pointerdown', this.#handlePointerDown);
    canvas.addEventListener('pointermove', this.#handlePointerMove);
    canvas.addEventListener('pointerup', this.#handlePointerUp);
    canvas.addEventListener('pointercancel', this.#handlePointerCancel);
    canvas.addEventListener('wheel', this.#handleWheel, { passive: false });
    canvas.addEventListener('keydown', this.#handleKeyDown);
    canvas.addEventListener('keyup', this.#handleKeyUp);
    canvas.addEventListener('blur', this.#handleBlur);
    canvas.addEventListener('contextmenu', this.#preventDefault);
    canvas.addEventListener('dragstart', this.#preventDefault);
    this.#view?.addEventListener('blur', this.#handleBlur);
  }

  #detachListeners(): void {
    const canvas = this.#canvas;
    canvas.removeEventListener('pointerdown', this.#handlePointerDown);
    canvas.removeEventListener('pointermove', this.#handlePointerMove);
    canvas.removeEventListener('pointerup', this.#handlePointerUp);
    canvas.removeEventListener('pointercancel', this.#handlePointerCancel);
    canvas.removeEventListener('wheel', this.#handleWheel);
    canvas.removeEventListener('keydown', this.#handleKeyDown);
    canvas.removeEventListener('keyup', this.#handleKeyUp);
    canvas.removeEventListener('blur', this.#handleBlur);
    canvas.removeEventListener('contextmenu', this.#preventDefault);
    canvas.removeEventListener('dragstart', this.#preventDefault);
    this.#view?.removeEventListener('blur', this.#handleBlur);
  }

  /**
   * Marks the canvas dirty and schedules at most one repaint per animation frame.
   *
   * Triggers, and the only triggers: `layers.subscribe` (a widget produced a frame, or a layer was
   * added/removed), an adopted host snapshot, `setMode` / `setSelection` / `cancelInteraction`,
   * every interaction step that reports `redraw` (pan, zoom, drag/resize/rotate preview, selection
   * change), and container resizes. An idle editor therefore holds no `requestAnimationFrame`.
   */
  #invalidate(): void {
    if (this.#disposed || !this.#mounted) {
      return;
    }
    this.#dirty = true;
    if (this.#frame !== 0) {
      return;
    }
    const view = this.#view;
    if (view === null) {
      this.#draw();
      return;
    }
    this.#frame = view.requestAnimationFrame(() => {
      this.#frame = 0;
      if (this.#disposed || !this.#dirty) {
        return;
      }
      this.#dirty = false;
      this.#draw();
    });
  }

  #draw(): void {
    this.#renderer.render({
      document: this.#snapshot,
      layers: this.#layers,
      previews: this.#session.previews,
      selection: this.#session.selection,
      viewport: this.#session.viewport,
      mode: this.#session.mode,
    });
  }

  #resize(): void {
    if (this.#disposed || !this.#mounted) {
      return;
    }
    const width = this.#root.clientWidth;
    const height = this.#root.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    this.#renderer.resize(width, height, this.#view?.devicePixelRatio ?? 1);
    this.#invalidate();
  }

  #report(diagnostic: CanvasEditorDiagnostic): void {
    try {
      this.#options.onDiagnostic?.(diagnostic);
    } catch {
      // A throwing diagnostic sink must not break input handling.
    }
  }

  #emitSelection(): void {
    const selection = this.#session.selection;
    if (sameIds(selection, this.#lastSelection)) {
      return;
    }
    this.#lastSelection = [...selection];
    try {
      this.#options.onSelectionChange?.(this.#lastSelection);
    } catch (error) {
      this.#report({
        code: 'canvas-editor/selection-failed',
        message: 'onSelectionChange threw.',
        cause: error,
      });
    }
  }

  #applyResult(result: InteractionResult): void {
    for (const command of result.commands) {
      this.#applyHostCommand(command);
    }
    for (const forwarded of result.events) {
      this.#forward(forwarded);
    }
    this.#emitSelection();
    if (result.redraw) {
      this.#invalidate();
    }
  }

  #forward(forwarded: ForwardedInput): void {
    try {
      this.#host.dispatch(forwarded.instanceId, forwarded.event);
    } catch (error) {
      this.#report({
        code: 'canvas-editor/dispatch-failed',
        message: `dispatch threw for instance "${forwarded.instanceId}".`,
        instanceId: forwarded.instanceId,
        cause: error,
      });
    }
  }

  #updateCursor(event?: { readonly clientX: number; readonly clientY: number }): void {
    if (this.#disposed || !this.#mounted) {
      return;
    }
    const canvas = this.#canvas;
    if (this.#session.interaction === 'panning') {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (this.#spaceHeld) {
      canvas.style.cursor = 'grab';
      return;
    }
    if (this.#session.mode === 'simulation') {
      canvas.style.cursor = 'default';
      return;
    }
    let cursor = 'default';
    if (event !== undefined) {
      const screenPoint = this.#toCanvasPoint(event);
      const documentPoint = screenToDocument(this.#session.viewport, screenPoint);
      const handle = handleUnderPointer(
        this.#snapshot,
        this.#session.selection,
        this.#session.viewport,
        documentPoint,
      );
      if (handle !== undefined) {
        cursor = CURSORS[handle.handle];
      } else if (hitTestTopmost(this.#snapshot.widgets, documentPoint) !== undefined) {
        cursor = 'move';
      }
    }
    canvas.style.cursor = cursor;
  }

  #toCanvasPoint(event: { readonly clientX: number; readonly clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #toPointerInput(event: PointerEvent): PointerInput {
    const point = this.#toCanvasPoint(event);
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
      spaceKey: this.#spaceHeld,
    };
  }

  #toKeyInput(event: KeyboardEvent): KeyInput {
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

  #capturePointer(pointerId: number): void {
    if (this.#canvas.hasPointerCapture(pointerId)) {
      return;
    }
    this.#canvas.setPointerCapture(pointerId);
  }

  #releasePointer(pointerId: number): void {
    if (this.#canvas.hasPointerCapture(pointerId)) {
      this.#canvas.releasePointerCapture(pointerId);
    }
  }

  readonly #preventDefault = (event: Event): void => {
    event.preventDefault();
  };

  readonly #handlePointerDown = (event: PointerEvent): void => {
    if (this.#disposed) {
      return;
    }
    const canvas = this.#canvas;
    canvas.focus({ preventScroll: true });
    if (event.button === 1) {
      // Middle-button panning would otherwise start autoscroll.
      event.preventDefault();
    }
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) {
      return;
    }
    this.#capturePointer(event.pointerId);
    this.#applyResult(this.#session.pointerDown(this.#snapshot, this.#toPointerInput(event)));
    this.#updateCursor(event);
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    if (this.#disposed) {
      return;
    }
    this.#applyResult(this.#session.pointerMove(this.#snapshot, this.#toPointerInput(event)));
    this.#updateCursor(event);
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    if (this.#disposed) {
      return;
    }
    this.#releasePointer(event.pointerId);
    this.#applyResult(this.#session.pointerUp(this.#snapshot, this.#toPointerInput(event)));
    this.#updateCursor(event);
  };

  readonly #handlePointerCancel = (event: PointerEvent): void => {
    if (this.#disposed) {
      return;
    }
    this.#releasePointer(event.pointerId);
    this.#applyResult(this.#session.pointerCancel(this.#snapshot, this.#toPointerInput(event)));
    this.#updateCursor();
  };

  readonly #handleWheel = (event: WheelEvent): void => {
    if (this.#disposed) {
      return;
    }
    event.preventDefault();
    const point = this.#toCanvasPoint(event);
    this.#applyResult(
      this.#session.wheel({
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        // Firefox reports lines and some devices pages; the session normalizes both to pixels.
        deltaMode: event.deltaMode,
        pageSize: this.#canvas.clientHeight,
        shiftKey: event.shiftKey,
      }),
    );
  };

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (this.#disposed) {
      return;
    }
    // Space is the pan modifier in both modes, so it must never scroll the page. Edit mode keeps
    // it away from the widgets; simulation mode still forwards the key after registering the modifier.
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      this.#spaceHeld = true;
      this.#updateCursor();
      if (this.#session.mode === 'edit') {
        return;
      }
    }
    if (this.#session.mode === 'edit' && ownsKey(event)) {
      event.preventDefault();
    }
    this.#applyResult(this.#session.keyDown(this.#snapshot, this.#toKeyInput(event)));
  };

  readonly #handleKeyUp = (event: KeyboardEvent): void => {
    if (this.#disposed) {
      return;
    }
    if (event.key === ' ' || event.code === 'Space') {
      this.#spaceHeld = false;
      this.#updateCursor();
    }
    this.#applyResult(this.#session.keyUp(this.#snapshot, this.#toKeyInput(event)));
  };

  readonly #handleBlur = (): void => {
    if (this.#disposed) {
      return;
    }
    if (this.#spaceHeld) {
      this.#spaceHeld = false;
      this.#updateCursor();
    }
    // A pointer that is lost (window switch, stolen capture) must never leave a gesture stuck: the
    // cancel drops the preview without a command and releases the pointer for the next press.
    this.#applyResult(this.#session.pointerCancel(this.#snapshot));
  };

  /**
   * Makes `next` the snapshot the editor draws. The reference check is what keeps a command from
   * being adopted twice: the host notifies `onDocumentChange` synchronously, and the command
   * handler adopts `host.getDocument()` afterwards.
   */
  #adopt(next: CanvasDocument): void {
    if (this.#disposed || next === this.#snapshot) {
      return;
    }
    this.#snapshot = next;
    this.#invalidate();
    if (this.#options.onChange === undefined) {
      return;
    }
    try {
      this.#options.onChange(next);
    } catch (error) {
      this.#report({
        code: 'canvas-editor/change-failed',
        message: 'onChange threw.',
        cause: error,
      });
    }
  }

  #applyHostCommand(command: CanvasCommand): void {
    if (this.#disposed) {
      return;
    }
    try {
      this.#host.applyCommand(command);
    } catch (error) {
      // The host kept its old snapshot, so the editor must keep drawing it.
      this.#report({
        code: 'canvas-editor/command-failed',
        message: `The host rejected "${command.type}": ${describeError(error)}`,
        cause: error,
      });
      return;
    }
    this.#adopt(this.#host.getDocument());
  }

  #applyMode(next: CanvasMode): void {
    if (this.#disposed || this.#session.mode === next) {
      return;
    }
    this.#session.setMode(next);
    this.#updateCursor();
    this.#invalidate();
  }
}

/**
 * Builds an editor, waits until it is mounted and returns it: shorthand for
 * `const editor = new CanvasEditor(options); await editor.ready;`.
 *
 * Use the constructor directly when the caller has to call {@link CanvasEditor.dispose} while the
 * provider is still creating the host or the host is still loading the document; this factory only
 * returns once `ready` settles. A failing provider or a rejected document makes the returned
 * promise reject with that error; nothing was mounted then.
 */
export async function createCanvasEditor(options: CanvasEditorOptions): Promise<CanvasEditor> {
  const editor = new CanvasEditor(options);
  await editor.ready;
  return editor;
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
