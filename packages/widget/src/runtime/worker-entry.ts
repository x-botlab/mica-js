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
  WIDGET_RESIZE_METHOD,
  WIDGET_SET_PROPERTIES_METHOD,
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
} from './protocol';
import { mergeProperties } from './props';
import type {
  WidgetDeliveryMeta,
  WidgetFactory,
  WidgetInputEvent,
  WidgetInstance,
  WidgetInstanceApi,
  WidgetPortListener,
} from './types';

/** Replaceable guest dependencies, so the runtime can be exercised outside a browser worker. */
export interface WidgetRuntimeOptions {
  /** Evaluates one widget module source; defaults to a blob URL plus dynamic `import()`. */
  readonly importModule?: (code: string) => Promise<unknown>;
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
  /** Releases every instance; the sandbox calls it when the guest is terminated. */
  dispose(): void;
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
  instance: WidgetInstance | undefined;
  /** Set once a factory or render failure stopped this instance for good. */
  failed: boolean;
  disposed: boolean;
}

const DEFAULT_DPR = 1;

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
  ctx.signal.addEventListener('abort', () => runtime.dispose(), { once: true });
}

/** Creates an isolated runtime instance; each sandbox (and each test) gets its own. */
export function createWidgetRuntime(
  ctx: GuestContext,
  options: WidgetRuntimeOptions = {},
): WidgetRuntime {
  const importModule = options.importModule ?? importBlobModule;
  const factories = new Map<string, WidgetFactory>();
  const definitions = new Map<string, WidgetDefinition>();
  const pendingFactories = new Map<string, Promise<WidgetFactory>>();
  const sessions = new Map<string, Session>();
  const dirty = new Set<Session>();
  let scheduled = false;
  let disposed = false;

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
    session.disposed = true;
    dirty.delete(session);
    session.subscriptions.clear();
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
    },

    unmount(instanceId) {
      const session = sessions.get(instanceId);
      if (!session) return;
      sessions.delete(instanceId);
      release(session);
    },

    resize(instanceId, width, height, dpr) {
      const session = requireSession(instanceId);
      session.width = toLogicalSize(width);
      session.height = toLogicalSize(height);
      session.dpr = toDpr(dpr);
      // Re-sizing the canvas discards the previous backing store; paint() restores the transform.
      session.canvas.width = toPixelSize(width, session.dpr);
      session.canvas.height = toPixelSize(height, session.dpr);
      dirty.delete(session);
      paint(session);
    },

    setProperties(instanceId, props) {
      const session = requireSession(instanceId);
      session.props = mergeProperties(session.properties, props);
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

    dispose() {
      if (disposed) return;
      disposed = true;
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

function importBlobModule(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
}
