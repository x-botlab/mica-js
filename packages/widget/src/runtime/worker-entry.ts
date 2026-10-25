import type { GuestContext } from '@mica-js/sandbox';
import type { PropertyDefinition, WidgetDefinition } from '../types';
import {
  WIDGET_ASSET_FAILED_EVENT,
  WIDGET_DELIVER_METHOD,
  WIDGET_ERROR_EVENT,
  WIDGET_FRAME_EVENT,
  WIDGET_LOAD_METHOD,
  WIDGET_MOUNT_METHOD,
  WIDGET_POINTER_METHOD,
  WIDGET_PUBLISH_EVENT,
  WIDGET_RESET_RUNTIME_METHOD,
  WIDGET_RESIZE_METHOD,
  WIDGET_SET_PROPERTIES_METHOD,
  WIDGET_TEXT_INPUT_EVENT,
  WIDGET_TEXT_INPUT_METHOD,
  WIDGET_TEXT_SELECTION_METHOD,
  WIDGET_UNMOUNT_METHOD,
} from './protocol';
import type {
  WidgetAssetFailedMessage,
  WidgetErrorMessage,
  WidgetErrorPhase,
  WidgetFrameMessage,
  WidgetLoadPackage,
  WidgetLoadRequest,
  WidgetMountRequest,
  WidgetPublishMessage,
  WidgetTextCommandMessage,
  WidgetTextInputNativeEvent,
  WidgetTextSelectionNativeEvent,
} from './protocol';
import { mergeProperties } from './props';
import type {
  TextInputEvent,
  TextInputListener,
  TextInputOptions,
  TextInputPosition,
  TextSelectionEvent,
  TextSelectionListener,
  TextSelectionOptions,
  TextSelectionRange,
  WidgetDeliveryMeta,
  WidgetFactory,
  WidgetInputEvent,
  WidgetInstance,
  WidgetInstanceApi,
  WidgetPortListener,
  WidgetPropsListener,
  WidgetResizeListener,
} from './types';

/** Replaceable guest dependencies, so the runtime can be exercised outside a browser worker. */
export interface WidgetRuntimeOptions {
  /** Evaluates one widget module source; defaults to a blob URL plus dynamic `import()`. */
  readonly importModule?: (code: string) => Promise<unknown>;
  /** Monotonic clock in milliseconds used for `tick` deltas; defaults to `performance.now()`. */
  readonly now?: () => number;
  /**
   * Schedules one animation frame and returns its canceller.
   *
   * Defaults to `requestAnimationFrame`, falling back to a 16 ms timer where no frame clock exists
   * (for example Node.js test workers).
   */
  readonly requestFrame?: (callback: () => void) => () => void;
  /** Decodes image bytes; defaults to the global `createImageBitmap`. */
  readonly createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>;
}

/** Guest-side widget runtime; every method maps to one `ctx.handle` entry. */
export interface WidgetRuntime {
  load(request: WidgetLoadRequest): Promise<void>;
  mount(request: WidgetMountRequest): void;
  unmount(instanceId: string): void;
  resize(instanceId: string, width: number, height: number, dpr: number): void;
  setProperties(instanceId: string, props: Readonly<Record<string, unknown>>): void;
  deliver(instanceId: string, port: string, payload: unknown, simTime: number): void;
  pointer(instanceId: string, event: WidgetInputEvent): void;
  /** Routes one native control event into the instance's text input state machine. */
  textInput(instanceId: string, event: unknown): void;
  /** Routes one native control event into the instance's selection session. */
  textSelection(instanceId: string, event: unknown): void;
  /**
   * Releases every instance and keeps the evaluated modules.
   *
   * A reset rebuilds instances, it does not re-evaluate modules: the contract puts instance state in
   * the factory closure, so keeping the factories is what makes the reset cheap.
   */
  resetRuntime(): void;
  /** Releases every instance; the sandbox calls it when the guest is terminated. */
  dispose(): void;
}

/** Mirrored text input session; the host owns the real `<textarea>`, this is its guest view. */
interface TextInputSessionState {
  active: boolean;
  text: string;
  cursorPosition: number;
  readonly listeners: Set<TextInputListener>;
}

/** Mirrored selection session over text the widget renders itself. */
interface TextSelectionSessionState {
  active: boolean;
  text: string;
  start: number;
  end: number;
  readonly listeners: Set<TextSelectionListener>;
  /** Last range listeners were told about, so a host echo does not repeat it. */
  notified: { start: number; end: number; text: string } | undefined;
}

interface Session {
  readonly instanceId: string;
  width: number;
  height: number;
  dpr: number;
  props: Readonly<Record<string, unknown>>;
  /** Property descriptors of the mounted widget, used to merge defaults again on updates. */
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
  readonly assets: Map<string, Uint8Array>;
  /** Assets already reported missing, so repeated reads do not flood diagnostics. */
  readonly reportedAssets: Set<string>;
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
  readonly subscriptions: Map<string, Set<WidgetPortListener>>;
  /** Registered in insertion order, so updates notify listeners in registration order. */
  readonly propsListeners: Set<WidgetPropsListener>;
  readonly resizeListeners: Set<WidgetResizeListener>;
  /** Guest mirror of the host's native text input control. */
  readonly textInput: TextInputSessionState;
  /** Guest mirror of the host's native selection control. */
  readonly textSelection: TextSelectionSessionState;
  instance: WidgetInstance | undefined;
  /** Set once a factory or render failure stopped this instance for good. */
  failed: boolean;
  disposed: boolean;
}

const DEFAULT_DPR = 1;
/** Fallback animation-frame interval in milliseconds (~60 FPS). */
const FRAME_INTERVAL_MS = 16;

/**
 * Guest entry point: the sandbox module loader looks for this export.
 *
 * The runtime is also reusable from tests, because it owns no module-level state.
 */
export function setup(ctx: GuestContext): void {
  const runtime = createWidgetRuntime(ctx);
  ctx.handle(WIDGET_LOAD_METHOD, (request: WidgetLoadRequest) => runtime.load(request));
  ctx.handle(WIDGET_MOUNT_METHOD, (request: WidgetMountRequest) => runtime.mount(request));
  ctx.handle(WIDGET_UNMOUNT_METHOD, (instanceId: string) => runtime.unmount(instanceId));
  ctx.handle(
    WIDGET_RESIZE_METHOD,
    (instanceId: string, width: number, height: number, dpr: number) =>
      runtime.resize(instanceId, width, height, dpr),
  );
  ctx.handle(
    WIDGET_SET_PROPERTIES_METHOD,
    (instanceId: string, props: Readonly<Record<string, unknown>>) =>
      runtime.setProperties(instanceId, props),
  );
  ctx.handle(
    WIDGET_DELIVER_METHOD,
    (instanceId: string, port: string, payload: unknown, simTime: number) =>
      runtime.deliver(instanceId, port, payload, simTime),
  );
  ctx.handle(WIDGET_POINTER_METHOD, (instanceId: string, event: WidgetInputEvent) =>
    runtime.pointer(instanceId, event),
  );
  ctx.handle(WIDGET_TEXT_INPUT_METHOD, (instanceId: string, event: unknown) =>
    runtime.textInput(instanceId, event),
  );
  ctx.handle(WIDGET_TEXT_SELECTION_METHOD, (instanceId: string, event: unknown) =>
    runtime.textSelection(instanceId, event),
  );
  ctx.handle(WIDGET_RESET_RUNTIME_METHOD, () => runtime.resetRuntime());
  ctx.signal.addEventListener('abort', () => runtime.dispose(), { once: true });
}

/** Creates an isolated runtime instance; each sandbox (and each test) gets its own. */
export function createWidgetRuntime(
  ctx: GuestContext,
  options: WidgetRuntimeOptions = {},
): WidgetRuntime {
  const importModule = options.importModule ?? importBlobModule;
  const now = options.now ?? defaultNow;
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const decodeImage = options.createImageBitmap;
  const factories = new Map<string, WidgetFactory>();
  const definitions = new Map<string, WidgetDefinition>();
  const pendingFactories = new Map<string, Promise<WidgetFactory>>();
  const sessions = new Map<string, Session>();
  const dirty = new Set<Session>();
  let scheduled = false;
  let disposed = false;
  let cancelFrame: (() => void) | undefined;
  let lastTickTime = 0;

  function report(phase: WidgetErrorPhase, instanceId: string, error: unknown): void {
    const payload: WidgetErrorMessage = {
      instanceId,
      phase,
      error: { name: errorName(error), message: errorMessage(error) },
    };
    try {
      ctx.emit(WIDGET_ERROR_EVENT, payload);
    } catch {
      // The sandbox is already gone; nothing left to report to.
    }
  }

  function invalidate(session: Session): void {
    if (session.failed || session.disposed || disposed) return;
    dirty.add(session);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  function flush(): void {
    scheduled = false;
    const pending = [...dirty];
    dirty.clear();
    for (const session of pending) {
      paint(session);
    }
  }

  function hasTickHandler(): boolean {
    for (const session of sessions.values()) {
      if (session.failed || session.disposed) continue;
      if (typeof session.instance?.tick === 'function') return true;
    }
    return false;
  }

  function stopTicking(): void {
    const cancel = cancelFrame;
    cancelFrame = undefined;
    cancel?.();
  }

  /** Starts the shared frame loop when at least one instance wants ticks, else stops it. */
  function syncTicking(): void {
    if (disposed || !hasTickHandler()) {
      stopTicking();
      return;
    }
    if (cancelFrame !== undefined) return;
    // A fresh loop starts from "now", so an idle period never turns into one huge delta.
    lastTickTime = now();
    scheduleTick();
  }

  function scheduleTick(): void {
    cancelFrame = requestFrame(runTickFrame);
  }

  function runTickFrame(): void {
    cancelFrame = undefined;
    if (disposed) return;

    const timestamp = now();
    const deltaMs = Math.max(0, timestamp - lastTickTime);
    lastTickTime = timestamp;

    for (const session of [...sessions.values()]) {
      if (session.failed || session.disposed) continue;
      const tick = session.instance?.tick;
      if (typeof tick !== 'function') continue;
      try {
        tick.call(session.instance, deltaMs);
      } catch (error) {
        // A failing tick pauses the instance like a failing render: report once, keep the rest.
        session.failed = true;
        dirty.delete(session);
        report('render', session.instanceId, error);
      }
    }

    // The tick callbacks may have unmounted instances or removed their handler; re-check instead
    // of trusting the state from the start of the frame.
    if (hasTickHandler()) scheduleTick();
  }

  function paint(session: Session): void {
    if (session.failed || session.disposed || disposed) return;

    const { context, canvas } = session;
    if (typeof context.setTransform === 'function') {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(session.dpr, 0, 0, session.dpr, 0, 0);
    }

    const render = session.instance?.render;
    if (typeof render === 'function') {
      try {
        render.call(session.instance, context);
      } catch (error) {
        session.failed = true;
        dirty.delete(session);
        report('render', session.instanceId, error);
        return;
      }
    }

    commit(session);
  }

  function commit(session: Session): void {
    let bitmap: ImageBitmap;
    try {
      bitmap = session.canvas.transferToImageBitmap();
    } catch (error) {
      session.failed = true;
      report('render', session.instanceId, error);
      return;
    }

    const payload: WidgetFrameMessage = {
      instanceId: session.instanceId,
      bitmap,
      width: session.width,
      height: session.height,
      dpr: session.dpr,
    };
    try {
      ctx.emit(WIDGET_FRAME_EVENT, payload, [bitmap]);
    } catch {
      closeBitmap(bitmap);
    }
  }

  function requireSession(instanceId: string): Session {
    const session = sessions.get(instanceId);
    if (!session) {
      throw new Error(`Widget instance ${JSON.stringify(instanceId)} is not mounted`);
    }
    return session;
  }

  function createSession(
    request: WidgetMountRequest,
    definition: WidgetDefinition | undefined,
  ): Session {
    const canvas = createCanvas(request.width, request.height, request.dpr);
    const properties = definition?.properties ?? {};
    return {
      instanceId: request.instanceId,
      width: toLogicalSize(request.width),
      height: toLogicalSize(request.height),
      dpr: toDpr(request.dpr),
      props: mergeProperties(properties, request.props),
      properties,
      assets: toAssetMap(request.assets),
      reportedAssets: new Set(),
      canvas,
      context: contextOf(canvas),
      subscriptions: new Map(),
      propsListeners: new Set(),
      resizeListeners: new Set(),
      textInput: { active: false, text: '', cursorPosition: 0, listeners: new Set() },
      textSelection: {
        active: false,
        text: '',
        start: 0,
        end: 0,
        listeners: new Set(),
        notified: undefined,
      },
      instance: undefined,
      failed: false,
      disposed: false,
    };
  }

  function reportAssetFailure(session: Session, src: string, message: string): void {
    if (session.disposed || disposed || session.reportedAssets.has(src)) return;
    session.reportedAssets.add(src);
    const payload: WidgetAssetFailedMessage = {
      instanceId: session.instanceId,
      src,
      error: { name: 'Error', message },
    };
    try {
      ctx.emit(WIDGET_ASSET_FAILED_EVENT, payload);
    } catch {
      // The sandbox is already gone; the rejection still reaches the widget.
    }
  }

  function readAsset(session: Session, src: string): Promise<Uint8Array> {
    if (typeof src !== 'string') {
      return Promise.reject(new TypeError('Widget asset src must be a string'));
    }
    const bytes = session.assets.get(src);
    if (bytes !== undefined && !session.disposed && !disposed) {
      // Hand out a copy: widgets are untrusted and must not mutate the shared prefetch buffer.
      return Promise.resolve(new Uint8Array(bytes));
    }

    const message = `Widget asset ${JSON.stringify(src)} was not prefetched`;
    if (session.disposed || disposed) {
      return Promise.reject(new Error(message));
    }
    reportAssetFailure(session, src, message);
    return Promise.reject(new Error(message));
  }

  async function loadImage(session: Session, src: string): Promise<ImageBitmap> {
    // `readAsset` validates `src`, reports missing resources, and hands out an isolated copy.
    const bytes = await readAsset(session, src);
    // Copy into a plain ArrayBuffer-backed view: a prefetched buffer may be shared-backed, which
    // `Blob` does not accept.
    const blob = new Blob([new Uint8Array(bytes)], { type: inferMimeType(src) });
    const decode =
      decodeImage ??
      ((data: Blob): Promise<ImageBitmap> => {
        if (typeof globalThis.createImageBitmap !== 'function') {
          return Promise.reject(
            new Error('The widget runtime cannot decode images: createImageBitmap is unavailable'),
          );
        }
        return globalThis.createImageBitmap(data);
      });
    return decode(blob);
  }

  function notifyPropsChanged(session: Session): void {
    if (session.failed || session.disposed || disposed) return;
    for (const listener of [...session.propsListeners]) {
      try {
        listener(session.props);
      } catch (error) {
        report('deliver', session.instanceId, error);
      }
    }
  }

  function notifyResize(session: Session): void {
    if (session.failed || session.disposed || disposed) return;
    for (const listener of [...session.resizeListeners]) {
      try {
        listener(session.width, session.height);
      } catch (error) {
        report('deliver', session.instanceId, error);
      }
    }
  }

  function isUsable(session: Session): boolean {
    return !session.failed && !session.disposed && !disposed;
  }

  /** Asks the host to drive its native control; the guest only keeps a mirror of the state. */
  function postTextCommand(session: Session, message: WidgetTextCommandMessage): void {
    // Deliberately not gated on the runtime-level `disposed` flag: releasing the last session
    // during `dispose()` must still tell the host to drop its overlay.
    if (session.disposed) return;
    try {
      ctx.emit(WIDGET_TEXT_INPUT_EVENT, message);
    } catch {
      // The sandbox is already gone; the session ends together with the instance.
    }
  }

  function notifyTextInput(session: Session, event: TextInputEvent): void {
    if (!isUsable(session)) return;
    for (const listener of [...session.textInput.listeners]) {
      try {
        listener(event);
      } catch (error) {
        report('deliver', session.instanceId, error);
      }
    }
  }

  function notifyTextSelection(session: Session, event: TextSelectionEvent): void {
    if (!isUsable(session)) return;
    for (const listener of [...session.textSelection.listeners]) {
      try {
        listener(event);
      } catch (error) {
        report('deliver', session.instanceId, error);
      }
    }
  }

  function selectionEvent(session: Session, type: TextSelectionEvent['type']): TextSelectionEvent {
    const state = session.textSelection;
    return {
      type,
      start: state.start,
      end: state.end,
      selectedText: state.text.slice(state.start, state.end),
    };
  }

  /** Reports a range only when listeners have not seen exactly this one, host echoes included. */
  function notifySelectionChange(session: Session, start: number, end: number): void {
    const state = session.textSelection;
    const selectedText = state.text.slice(start, end);
    const last = state.notified;
    if (last?.start === start && last.end === end && last.text === selectedText) return;
    state.notified = { start, end, text: selectedText };
    notifyTextSelection(session, { type: 'change', start, end, selectedText });
  }

  function beginTextInput(session: Session, options: TextInputOptions): void {
    if (!isUsable(session)) return;
    const input: Partial<TextInputOptions> =
      typeof options === 'object' && options !== null ? options : {};
    const text = toText(input.initialText);
    const cursorPosition = toOffset(input.cursorPosition, text.length);

    const state = session.textInput;
    state.active = true;
    state.text = text;
    state.cursorPosition = cursorPosition;

    postTextCommand(session, {
      type: 'begin',
      session: 'input',
      instanceId: session.instanceId,
      x: toCoordinate(input.x),
      y: toCoordinate(input.y),
      width: toExtent(input.width, DEFAULT_TEXT_INPUT_WIDTH),
      height: toExtent(input.height, DEFAULT_TEXT_INPUT_HEIGHT),
      text,
      cursorPosition,
    });
  }

  function updateTextInput(session: Session, position: TextInputPosition): void {
    if (!session.textInput.active || !isUsable(session)) return;
    const target: Partial<TextInputPosition> =
      typeof position === 'object' && position !== null ? position : {};
    postTextCommand(session, {
      type: 'update',
      session: 'input',
      instanceId: session.instanceId,
      x: toCoordinate(target.x),
      y: toCoordinate(target.y),
    });
  }

  function commitTextInput(session: Session): void {
    const state = session.textInput;
    if (!state.active || !isUsable(session)) return;
    // Flip the flag before asking the host: its commit acknowledgement then lands on a closed
    // session and listeners hear exactly one commit event.
    const event: TextInputEvent = {
      type: 'commit',
      text: state.text,
      cursorPosition: state.cursorPosition,
    };
    state.active = false;
    postTextCommand(session, { type: 'commit', session: 'input', instanceId: session.instanceId });
    notifyTextInput(session, event);
  }

  function cancelTextInput(session: Session): void {
    const state = session.textInput;
    if (!state.active || !isUsable(session)) return;
    const event: TextInputEvent = {
      type: 'cancel',
      text: state.text,
      cursorPosition: state.cursorPosition,
    };
    state.active = false;
    postTextCommand(session, { type: 'cancel', session: 'input', instanceId: session.instanceId });
    notifyTextInput(session, event);
  }

  function beginTextSelection(session: Session, options: TextSelectionOptions): void {
    if (!isUsable(session)) return;
    const input: Partial<TextSelectionOptions> =
      typeof options === 'object' && options !== null ? options : {};
    const text = toText(input.text);
    const range = orderedRange(text, input.start, input.end);

    const state = session.textSelection;
    state.active = true;
    state.text = text;
    state.start = range.start;
    state.end = range.end;
    state.notified = undefined;

    postTextCommand(session, {
      type: 'begin',
      session: 'selection',
      instanceId: session.instanceId,
      x: toCoordinate(input.x),
      y: toCoordinate(input.y),
      width: toExtent(input.width, DEFAULT_TEXT_INPUT_WIDTH),
      height: toExtent(input.height, DEFAULT_TEXT_INPUT_HEIGHT),
      text,
      start: range.start,
      end: range.end,
    });
    // The widget already knows the range it opened; listeners get the first change right away
    // instead of waiting for the host to echo a native selection event.
    notifySelectionChange(session, range.start, range.end);
  }

  function updateTextSelection(session: Session, range: TextSelectionRange): void {
    const state = session.textSelection;
    if (!state.active || !isUsable(session)) return;
    const input: Partial<TextSelectionRange> =
      typeof range === 'object' && range !== null ? range : {};
    const next = orderedRange(state.text, input.start, input.end);
    state.start = next.start;
    state.end = next.end;
    postTextCommand(session, {
      type: 'update',
      session: 'selection',
      instanceId: session.instanceId,
      start: next.start,
      end: next.end,
    });
    notifySelectionChange(session, next.start, next.end);
  }

  function commitTextSelection(session: Session): void {
    const state = session.textSelection;
    if (!state.active || !isUsable(session)) return;
    const event = selectionEvent(session, 'commit');
    state.active = false;
    postTextCommand(session, {
      type: 'commit',
      session: 'selection',
      instanceId: session.instanceId,
    });
    notifyTextSelection(session, event);
  }

  function cancelTextSelection(session: Session): void {
    const state = session.textSelection;
    if (!state.active || !isUsable(session)) return;
    const event = selectionEvent(session, 'cancel');
    state.active = false;
    postTextCommand(session, {
      type: 'cancel',
      session: 'selection',
      instanceId: session.instanceId,
    });
    notifyTextSelection(session, event);
  }

  /** Applies one native control event from the host to the mirrored input session. */
  function routeTextInput(session: Session, event: unknown): void {
    const state = session.textInput;
    if (!state.active || !isUsable(session)) return;
    if (typeof event !== 'object' || event === null) return;
    const input = event as Partial<WidgetTextInputNativeEvent>;

    switch (input.type) {
      case 'compositionstart':
      case 'compositionupdate':
      case 'compositionend':
      case 'input': {
        // Composition events carry the string the IME is editing; `input` carries the full value.
        const text = toText(input.text);
        state.text = text;
        state.cursorPosition = toOffset(input.cursorPosition, text.length);
        notifyTextInput(session, {
          type: 'composing',
          text,
          cursorPosition: state.cursorPosition,
        });
        return;
      }
      case 'commit': {
        const text = toText(input.text);
        state.text = text;
        state.cursorPosition = toOffset(input.cursorPosition, text.length);
        state.active = false;
        notifyTextInput(session, {
          type: 'commit',
          text,
          cursorPosition: state.cursorPosition,
        });
        return;
      }
      case 'cancel': {
        state.active = false;
        notifyTextInput(session, {
          type: 'cancel',
          text: state.text,
          cursorPosition: state.cursorPosition,
        });
        return;
      }
      default:
        return;
    }
  }

  /** Applies one native selection event from the host to the mirrored selection session. */
  function routeTextSelection(session: Session, event: unknown): void {
    const state = session.textSelection;
    if (!state.active || !isUsable(session)) return;
    if (typeof event !== 'object' || event === null) return;
    const input = event as Partial<WidgetTextSelectionNativeEvent>;

    switch (input.type) {
      case 'change': {
        const next = orderedRange(state.text, input.start, input.end);
        state.start = next.start;
        state.end = next.end;
        notifySelectionChange(session, next.start, next.end);
        return;
      }
      case 'commit': {
        const next = orderedRange(state.text, input.start, input.end);
        state.start = next.start;
        state.end = next.end;
        state.active = false;
        notifyTextSelection(session, selectionEvent(session, 'commit'));
        return;
      }
      case 'cancel': {
        state.active = false;
        notifyTextSelection(session, selectionEvent(session, 'cancel'));
        return;
      }
      default:
        return;
    }
  }

  /** Closes both mirrored sessions and lets the host tear its overlay down with the instance. */
  function endTextSessions(session: Session): void {
    if (session.textInput.active) {
      session.textInput.active = false;
      postTextCommand(session, {
        type: 'cancel',
        session: 'input',
        instanceId: session.instanceId,
      });
    }
    if (session.textSelection.active) {
      session.textSelection.active = false;
      postTextCommand(session, {
        type: 'cancel',
        session: 'selection',
        instanceId: session.instanceId,
      });
    }
    session.textInput.listeners.clear();
    session.textSelection.listeners.clear();
    session.textInput.text = '';
    session.textInput.cursorPosition = 0;
    session.textSelection.text = '';
    session.textSelection.notified = undefined;
  }

  function createApi(session: Session): WidgetInstanceApi {
    return {
      instanceId: session.instanceId,
      get width() {
        return session.width;
      },
      get height() {
        return session.height;
      },
      get props() {
        return session.props;
      },
      assets: {
        readBinary: (src: string) => readAsset(session, src),
        loadImage: (src: string) => loadImage(session, src),
      },
      textInput: {
        begin: (options: TextInputOptions) => beginTextInput(session, options),
        update: (position: TextInputPosition) => updateTextInput(session, position),
        commit: () => commitTextInput(session),
        cancel: () => cancelTextInput(session),
      },
      textSelection: {
        begin: (options: TextSelectionOptions) => beginTextSelection(session, options),
        update: (range: TextSelectionRange) => updateTextSelection(session, range),
        commit: () => commitTextSelection(session),
        cancel: () => cancelTextSelection(session),
      },
      onTextInput(listener: TextInputListener) {
        if (session.disposed || typeof listener !== 'function') return () => {};
        session.textInput.listeners.add(listener);
        return () => {
          session.textInput.listeners.delete(listener);
        };
      },
      onTextSelection(listener: TextSelectionListener) {
        if (session.disposed || typeof listener !== 'function') return () => {};
        session.textSelection.listeners.add(listener);
        return () => {
          session.textSelection.listeners.delete(listener);
        };
      },
      subscribe(port: string, listener: WidgetPortListener) {
        if (session.disposed || typeof listener !== 'function') return () => {};
        let listeners = session.subscriptions.get(port);
        if (!listeners) {
          listeners = new Set();
          session.subscriptions.set(port, listeners);
        }
        listeners.add(listener);
        return () => {
          session.subscriptions.get(port)?.delete(listener);
        };
      },
      onPropsChanged(listener: WidgetPropsListener) {
        if (session.disposed || typeof listener !== 'function') return () => {};
        session.propsListeners.add(listener);
        return () => {
          session.propsListeners.delete(listener);
        };
      },
      onResize(listener: WidgetResizeListener) {
        if (session.disposed || typeof listener !== 'function') return () => {};
        session.resizeListeners.add(listener);
        return () => {
          session.resizeListeners.delete(listener);
        };
      },
      publish(port: string, payload: unknown, simTime?: number) {
        if (session.disposed || disposed) return;
        const message: WidgetPublishMessage = {
          instanceId: session.instanceId,
          port,
          payload,
          simTime: toSimTime(simTime),
        };
        try {
          ctx.emit(WIDGET_PUBLISH_EVENT, message);
        } catch (error) {
          report('deliver', session.instanceId, error);
        }
      },
      invalidate() {
        invalidate(session);
      },
    };
  }

  function release(session: Session): void {
    // Emitted before `disposed` flips, so the host can drop an overlay that outlives its widget.
    endTextSessions(session);
    session.disposed = true;
    dirty.delete(session);
    session.subscriptions.clear();
    session.propsListeners.clear();
    session.resizeListeners.clear();
    const instance = session.instance;
    session.instance = undefined;
    if (instance && typeof instance.dispose === 'function') {
      try {
        instance.dispose();
      } catch (error) {
        report('render', session.instanceId, error);
      }
    }
    // Drop the backing store right away instead of waiting for the worker to be torn down.
    session.assets.clear();
    session.canvas.width = 1;
    session.canvas.height = 1;
  }

  async function evaluate(ref: string, code: string): Promise<WidgetFactory> {
    const loaded = (await importModule(code)) as { default?: unknown } | null;
    const factory = loaded && typeof loaded === 'object' ? loaded.default : undefined;
    if (typeof factory !== 'function') {
      throw new Error(`Widget ${JSON.stringify(ref)} must default-export a factory function`);
    }
    return factory as WidgetFactory;
  }

  return {
    async load(request: WidgetLoadRequest) {
      const packages: readonly WidgetLoadPackage[] = Array.isArray(request.packages)
        ? request.packages
        : [];
      let failure: unknown;
      let failed = false;

      for (const pkg of packages) {
        const modules = pkg.modules;
        if (!modules || typeof modules !== 'object') continue;
        for (const widgetId of Object.keys(modules)) {
          const widgetModule = modules[widgetId];
          if (!widgetModule) continue;
          const ref = `${pkg.id}:${widgetId}`;
          if (factories.has(ref)) continue;

          try {
            let pending = pendingFactories.get(ref);
            if (!pending) {
              pending = evaluate(ref, widgetModule.code);
              pendingFactories.set(ref, pending);
            }
            factories.set(ref, await pending);
            definitions.set(ref, widgetModule.definition);
          } catch (error) {
            if (!failed) {
              failure = error;
              failed = true;
            }
          } finally {
            pendingFactories.delete(ref);
          }
        }
      }

      if (failed) throw failure;
    },

    mount(request) {
      if (disposed) throw new Error('The widget runtime is disposed');
      const { instanceId, widget } = request;
      if (sessions.has(instanceId)) {
        throw new Error(`Widget instance ${JSON.stringify(instanceId)} is already mounted`);
      }
      const factory = factories.get(widget);
      if (!factory) {
        throw new Error(`Widget ${JSON.stringify(widget)} is not loaded`);
      }

      const session = createSession(request, definitions.get(widget));
      sessions.set(instanceId, session);

      try {
        session.instance = toWidgetInstance(factory(createApi(session)));
      } catch (error) {
        sessions.delete(instanceId);
        release(session);
        report('mount', instanceId, error);
        throw error instanceof Error ? error : new Error(String(error));
      }

      // A factory may call `invalidate()` while building; the first paint below covers that
      // request, so drop the queued repaint instead of committing a second identical frame.
      dirty.delete(session);
      paint(session);
      syncTicking();
    },

    unmount(instanceId) {
      const session = sessions.get(instanceId);
      if (!session) return;
      sessions.delete(instanceId);
      release(session);
      syncTicking();
    },

    resize(instanceId, width, height, dpr) {
      const session = requireSession(instanceId);
      const logicalWidth = toLogicalSize(width);
      const logicalHeight = toLogicalSize(height);
      const sizeChanged = session.width !== logicalWidth || session.height !== logicalHeight;
      session.width = logicalWidth;
      session.height = logicalHeight;
      session.dpr = toDpr(dpr);
      // Re-sizing the canvas discards the previous backing store; paint() restores the transform.
      session.canvas.width = toPixelSize(width, session.dpr);
      session.canvas.height = toPixelSize(height, session.dpr);
      // Listeners see the new api.width / api.height, then the repaint follows below.
      if (sizeChanged) notifyResize(session);
      dirty.delete(session);
      paint(session);
    },

    setProperties(instanceId, props) {
      const session = requireSession(instanceId);
      // `api.props` updates first, then listeners run in registration order, then a repaint.
      session.props = mergeProperties(session.properties, props);
      notifyPropsChanged(session);
      invalidate(session);
    },

    deliver(instanceId, port, payload, simTime) {
      const session = requireSession(instanceId);
      const listeners = session.subscriptions.get(port);
      if (!listeners || listeners.size === 0) return;

      const meta: WidgetDeliveryMeta = { simTime };
      for (const listener of [...listeners]) {
        try {
          listener(payload, meta);
        } catch (error) {
          report('deliver', instanceId, error);
        }
      }
    },

    pointer(instanceId, event) {
      const session = requireSession(instanceId);
      if (session.failed || session.disposed) return;
      const handler = session.instance?.input;
      if (typeof handler !== 'function') return;
      try {
        handler.call(session.instance, event);
      } catch (error) {
        report('deliver', instanceId, error);
      }
    },

    textInput(instanceId, event) {
      // A native event can reach the guest after the instance was unmounted; that is not an error.
      const session = sessions.get(instanceId);
      if (!session) return;
      routeTextInput(session, event);
    },

    textSelection(instanceId, event) {
      const session = sessions.get(instanceId);
      if (!session) return;
      routeTextSelection(session, event);
    },

    resetRuntime() {
      if (disposed) return;
      stopTicking();
      dirty.clear();
      for (const session of [...sessions.values()]) {
        sessions.delete(session.instanceId);
        release(session);
      }
      sessions.clear();
      // Factories and definitions stay: a reset rebuilds instances, it does not re-evaluate modules.
      // Anything a widget keeps at module scope therefore survives the reset, which is why instance
      // state belongs inside the factory closure (`x-botlab/mica-js#2`).
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopTicking();
      dirty.clear();
      for (const session of [...sessions.values()]) {
        release(session);
      }
      sessions.clear();
      factories.clear();
      definitions.clear();
      pendingFactories.clear();
    },
  };
}

function createCanvas(width: number, height: number, dpr: number): OffscreenCanvas {
  return new OffscreenCanvas(toPixelSize(width, dpr), toPixelSize(height, dpr));
}

function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('The widget runtime needs a 2D context');
  }
  return context;
}

function toWidgetInstance(value: unknown): WidgetInstance {
  return value && typeof value === 'object' ? (value as WidgetInstance) : {};
}

function toLogicalSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function toDpr(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DPR;
}

function toPixelSize(logical: number, dpr: number): number {
  return Math.max(1, Math.round(toLogicalSize(logical) * toDpr(dpr)));
}

function toAssetMap(
  assets: Readonly<Record<string, Uint8Array>> | undefined,
): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  if (typeof assets !== 'object' || assets === null) return map;
  for (const key of Object.keys(assets)) {
    const bytes = assets[key];
    // The mount message is structured-cloned, but copy anyway so the widget's API never shares
    // a buffer with whatever the host sent.
    if (bytes instanceof Uint8Array) map.set(key, new Uint8Array(bytes));
  }
  return map;
}

function toSimTime(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Overlay defaults from the RFC; a widget that passes no size still gets a usable control. */
const DEFAULT_TEXT_INPUT_WIDTH = 100;
const DEFAULT_TEXT_INPUT_HEIGHT = 20;

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toCoordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toExtent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Clamps a caret offset to `[0, length]`; invalid input falls back to `fallback`. */
function toOffset(value: unknown, length: number, fallback = 0): number {
  const offset = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(offset, 0), length);
}

/** Clamps both ends to `text` and orders them, so `start <= end` always holds. */
function orderedRange(
  text: string,
  start: unknown,
  end: unknown,
): { readonly start: number; readonly end: number } {
  const first = toOffset(start, text.length);
  const second = toOffset(end, text.length, first);
  return first <= second ? { start: first, end: second } : { start: second, end: first };
}

function closeBitmap(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch {
    // Already detached.
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' ? error : String(error);
}

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** MIME type for a resource path, ignoring any query string or fragment. */
function inferMimeType(src: string): string {
  const path = src.split(/[?#]/)[0] ?? '';
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_TYPES[extension] ?? 'application/octet-stream';
}

function defaultNow(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

function defaultRequestFrame(callback: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    const handle = globalThis.requestAnimationFrame(() => callback());
    return () => globalThis.cancelAnimationFrame?.(handle);
  }
  const timer = setTimeout(callback, FRAME_INTERVAL_MS);
  return () => clearTimeout(timer);
}

function importBlobModule(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
}
