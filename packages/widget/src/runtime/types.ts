/** Metadata passed to every port listener next to the payload. */
export interface WidgetDeliveryMeta {
  /** Simulation time at which the host routed the payload. */
  readonly simTime: number;
}

/** Listener registered for one input port through `WidgetInstanceApi.subscribe`. */
export type WidgetPortListener = (payload: unknown, meta: WidgetDeliveryMeta) => void;

/** Listener registered through `WidgetInstanceApi.onPropsChanged`. */
export type WidgetPropsListener = (props: Readonly<Record<string, unknown>>) => void;

/** Listener registered through `WidgetInstanceApi.onResize`. */
export type WidgetResizeListener = (width: number, height: number) => void;

/** Image / binary property value from the shared descriptor contract (#7). */
export interface WidgetAssetRef {
  readonly src: string;
  readonly mode: 'file' | 'inline' | 'store';
}

/**
 * Reads resources the host prefetched when the instance was mounted. Guests have no network and
 * no DOM, so every byte a widget sees arrives through this interface.
 */
export interface WidgetAssetApi {
  /**
   * Resolves to a copy of the prefetched bytes for `src`; the widget may mutate it freely.
   *
   * Rejects when the resource was not prefetched: no `WidgetAssetProvider` was configured, the host
   * failed to read it, or a property introduced it after mount. The first missing read per
   * instance and `src` also reports `widget/asset-failed`. Callers must handle the rejection;
   * ignoring it leaves an unhandled rejection in the guest worker.
   */
  readBinary(src: string): Promise<Uint8Array>;
  /**
   * Resolves to an `ImageBitmap` decoded from the prefetched bytes for `src`.
   *
   * The caller owns the bitmap and must `close()` it when done. Rejects with the same rules as
   * `readBinary`, plus decoding failures (the bytes are not an image the browser can decode).
   */
  loadImage(src: string): Promise<ImageBitmap>;
}

/**
 * Opens a native text control next to the widget.
 *
 * Coordinates are logical widget units, like every other API position. The host positions a hidden
 * `<textarea>` at `(x, y)`, so the operating system input method editor (IME), clipboard and
 * selection handles work exactly as they do in a regular form field.
 */
export interface TextInputOptions {
  readonly x: number;
  readonly y: number;
  /** Overlay width in logical units. Defaults to `100`. */
  readonly width?: number;
  /** Overlay height in logical units. Defaults to `20`. */
  readonly height?: number;
  /** Text the session starts with. Defaults to `''`. */
  readonly initialText?: string;
  /** Caret offset into `initialText`, clamped to its length. Defaults to `0`. */
  readonly cursorPosition?: number;
}

/** One event of the text input session started with `api.textInput.begin`. */
export interface TextInputEvent {
  /**
   * `composing` while the IME edits (compositionstart / compositionupdate / compositionend and
   * plain `input`), `commit` when the text is final, `cancel` when the session was abandoned.
   */
  readonly type: 'composing' | 'commit' | 'cancel';
  /** Composed text while composing; the full value once committed. */
  readonly text: string;
  /** Caret offset into `text`. */
  readonly cursorPosition: number;
}

/** Position of the native control, in logical widget units. */
export interface TextInputPosition {
  readonly x: number;
  readonly y: number;
}

/** Starts, moves and finishes one text input session. */
export interface WidgetTextInputApi {
  /** Opens the host-side native control and makes it the active input target. */
  begin(options: TextInputOptions): void;
  /** Moves the native control, e.g. after the widget scrolled or relaid out. */
  update(position: TextInputPosition): void;
  /** Ends the session and reports the current text as committed. */
  commit(): void;
  /** Ends the session without committing, e.g. on Escape. */
  cancel(): void;
}

/** Text the widget drew itself, which the host should expose through native selection handles. */
export interface TextSelectionOptions {
  readonly text: string;
  /** Start offset of the initial selection, clamped to `text`. */
  readonly start: number;
  /** End offset of the initial selection, clamped to `text`. */
  readonly end: number;
  readonly x: number;
  readonly y: number;
  /** Overlay width in logical units. Defaults to `100`. */
  readonly width?: number;
  /** Overlay height in logical units. Defaults to `20`. */
  readonly height?: number;
}

/** One event of the selection session started with `api.textSelection.begin`. */
export interface TextSelectionEvent {
  readonly type: 'change' | 'commit' | 'cancel';
  /** Selection start offset into the text passed to `begin`. */
  readonly start: number;
  /** Selection end offset into the text passed to `begin`. */
  readonly end: number;
  /** `text.slice(start, end)`; empty for a collapsed caret. */
  readonly selectedText: string;
}

/** Range of a selection session, in offsets of the text passed to `begin`. */
export interface TextSelectionRange {
  readonly start: number;
  readonly end: number;
}

/** Starts, updates and finishes one native selection session. */
export interface WidgetTextSelectionApi {
  /** Opens the host-side selection control over the text the widget already renders. */
  begin(options: TextSelectionOptions): void;
  /** Applies a widget-driven range change; listeners receive a `change` event. */
  update(range: TextSelectionRange): void;
  /** Ends the session and reports the current range as committed. */
  commit(): void;
  /** Ends the session without committing. */
  cancel(): void;
}

/** Receives `TextInputEvent`s of one instance. */
export type TextInputListener = (event: TextInputEvent) => void;

/** Receives `TextSelectionEvent`s of one instance. */
export type TextSelectionListener = (event: TextSelectionEvent) => void;

/**
 * Per-instance API handed to a widget factory. Sizes are logical units: the guest runtime applies
 * the device pixel ratio, so widgets never multiply coordinates themselves.
 */
export interface WidgetInstanceApi {
  readonly instanceId: string;
  readonly width: number;
  readonly height: number;
  /** Document props merged over `definition.properties[*].default`. */
  readonly props: Readonly<Record<string, unknown>>;
  /** Prefetched image / binary resources for this instance. */
  readonly assets: WidgetAssetApi;
  /**
   * Native text entry through a host-side `<textarea>` proxy. Nothing listens for
   * `onTextInput` until the widget subscribes, so a session nobody observes is harmless.
   */
  readonly textInput: WidgetTextInputApi;
  /** Native selection over text the widget drew itself. */
  readonly textSelection: WidgetTextSelectionApi;
  /** Subscribes to composition / commit / cancel events; the returned function unsubscribes. */
  onTextInput(listener: TextInputListener): () => void;
  /** Subscribes to selection changes; the returned function unsubscribes. */
  onTextSelection(listener: TextSelectionListener): () => void;
  /** Subscribes to one input port; the returned function unsubscribes. */
  subscribe(port: string, listener: WidgetPortListener): () => void;
  /**
   * Subscribes to committed property updates; the returned function unsubscribes.
   *
   * `api.props` already holds the new snapshot when a listener runs, and listeners run serially in
   * registration order. Initial props are read from `api.props`, so no notification fires on mount.
   */
  onPropsChanged(listener: WidgetPropsListener): () => void;
  /**
   * Subscribes to logical size changes; the returned function unsubscribes.
   *
   * `api.width` / `api.height` already hold the new size when a listener runs, and listeners run
   * serially in registration order. A device-pixel-ratio-only change repaints without notifying.
   */
  onResize(listener: WidgetResizeListener): () => void;
  /**
   * Sends a payload out of one output port.
   *
   * `simTime` is the simulation time the widget reacted to. The current host has no simulation
   * clock, so an omitted value is published as `0`.
   */
  publish(port: string, payload: unknown, simTime?: number): void;
  /** Requests a repaint; repeated calls in the same tick coalesce into one frame. */
  invalidate(): void;
}

/** Pointer or keyboard input forwarded to one instance. */
export interface WidgetInputEvent {
  /** DOM event type, e.g. `pointerdown`, `pointermove` or `keydown`. */
  readonly type: string;
  /** Pointer position in logical widget units, for pointer events. */
  readonly x?: number;
  readonly y?: number;
  readonly button?: number;
  readonly buttons?: number;
  /** `KeyboardEvent.key`, for keyboard events. */
  readonly key?: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * Object a widget factory may return. Every hook is optional, so a pure-logic widget can return
 * nothing at all; an instance without `render` still produces one blank frame per repaint.
 */
export interface WidgetInstance {
  /** Draws using logical units; the context is already scaled by the device pixel ratio. */
  render?(context: OffscreenCanvasRenderingContext2D): void;
  input?(event: WidgetInputEvent): void;
  /**
   * Runs once per animation frame (~60 FPS) while the instance is mounted.
   *
   * `deltaMs` is the wall-clock time since the previous tick in milliseconds. Ticking does not
   * imply a repaint: call `api.invalidate()` when the frame should be redrawn. A throwing tick
   * pauses the instance like a failing `render`.
   */
  tick?(deltaMs: number): void;
  dispose?(): void;
}

/** Default export of a widget implementation module. */
export type WidgetFactory = (api: WidgetInstanceApi) => WidgetInstance | void;
