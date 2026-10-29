import { createRpc } from '@mica-js/core/rpc';
import { loggerService } from '@mica-js/core/logging';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { CanvasBindingTarget } from '@mica-js/core/canvas';
import type { SimulationPublish } from '@mica-js/simulator';
import type { PropertyDefinition, WidgetDefinition } from '../../types';
import { createWidgetAudioRuntime } from '../audio/controller';
import type { WidgetAudioRuntime } from '../audio/controller';
import { widgetAudioGuestService } from '../audio/protocol';
import type { WidgetAudioState } from '../audio/protocol';
import {
  widgetAssetFailedEvent,
  widgetDeliverMethod,
  widgetErrorEvent,
  widgetFrameEvent,
  widgetGuestControlService,
  widgetGuestService,
  widgetHostControlService,
  widgetHostEventMethod,
  widgetLoadMethod,
  widgetMountMethod,
  widgetPointerMethod,
  widgetPublishEvent,
  widgetResetRuntimeMethod,
  widgetResizeMethod,
  widgetSetBindingsMethod,
  widgetSetPropertiesMethod,
  widgetUnmountMethod,
  widgetDeviceTopicService,
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
  WidgetDeviceTopicChannel,
} from './protocol';
import { mergeProperties } from './props';
import type {
  WidgetDeliveryMeta,
  WidgetFactory,
  WidgetInputEvent,
  WidgetImplementation,
  WidgetInstanceApi,
  WidgetPortListener,
} from './types';

/** Replaceable guest dependencies, so the runtime can be exercised outside a browser worker. */
export interface WidgetRuntimeOptions {
  /** Evaluates one widget module source; defaults to a blob URL plus dynamic `import()`. */
  readonly importModule?: (code: string) => Promise<unknown>;
  /**
   * Direct device channel (RFC 0018). Present only when the worker was handed a device port, in
   * which case the guest routes topic traffic itself and the host stops relaying it.
   */
  readonly device?: WidgetDeviceTopicChannel;
}

/** Guest-side widget runtime; every method maps to one member of {@link widgetGuestService}. */
export interface WidgetRuntime {
  load(request: WidgetLoadRequest): Promise<void>;
  mount(request: WidgetMountRequest): void;
  unmount(instanceId: string): void;
  resize(instanceId: string, width: number, height: number, dpr: number): void;
  setProperties(instanceId: string, props: Readonly<Record<string, unknown>>): void;
  /**
   * Replaces the endpoints this instance writes to and reads from.
   *
   * Only a guest with a direct device channel routes on its own; without one the host keeps the
   * binding map and the call changes nothing.
   */
  setBindings(instanceId: string, bindings: Readonly<Record<string, CanvasBindingTarget>>): void;
  deliver(instanceId: string, port: string, payload: unknown, simTime: number): void;
  pointer(instanceId: string, event: WidgetInputEvent): void;
  /**
   * Releases every instance and keeps the evaluated modules.
   *
   * A reset rebuilds instances, it does not re-evaluate modules: the contract puts instance state in
   * the factory closure, so keeping the factories is what makes the reset cheap.
   */
  resetRuntime(): void;
  /** Releases every instance; the sandbox calls it when the guest is terminated. */
  dispose(): void;
  /** Takes the direct worker ↔ worklet port (RFC 0016). */
  attachAudioPort(port: MessagePort): void;
  /** Applies an availability change the host pushed after mount. */
  setAudioState(state: WidgetAudioState): void;
}

/**
 * Guest-side event bridge. The worker script implements it over the sandbox port; tests pass a
 * plain object, so the runtime never depends on RPC itself.
 */
export interface WidgetRuntimeChannel {
  emit(type: string, payload?: unknown, transfer?: readonly Transferable[]): void;
  on(type: string, listener: (payload: unknown) => void): () => void;
}

export interface WidgetWorkerOptions extends WidgetRuntimeOptions {
  /** Creates the endpoint over the startup port; tests inject a fake. */
  readonly createEndpoint?: (port: MessagePort) => RpcEndpoint;
  /**
   * Extra startup ports the worker received. The sandbox port comes first, so these are
   * `event.ports` from index 1 onward; the first one is the direct device channel (RFC 0018).
   */
  readonly ports?: readonly MessagePort[];
}

/** Guest runtime plus the RPC endpoint that serves it. */
export interface WidgetWorkerRuntime {
  readonly runtime: WidgetRuntime;
  /** Disposes the runtime, the endpoint and the startup port. */
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
  /** Port → device endpoint the host validated; the guest routes with it in direct mode. */
  bindings: Readonly<Record<string, CanvasBindingTarget>>;
  instance: WidgetImplementation | undefined;
  /** Set once a factory or render failure stopped this instance for good. */
  failed: boolean;
  disposed: boolean;
}

const DEFAULT_DPR = 1;

/**
 * Worker entry point: binds the widget runtime to the port the sandbox transferred as
 * `event.ports[0]`.
 *
 * The sandbox owns isolation only, so the guest registers itself: `guest` mirrors every host
 * method, `guest-control` receives host events, and everything the runtime emits goes back over
 * `host-control`. The returned handle is also useful in tests, which inject a fake endpoint.
 */
export function startWidgetRuntime(
  port: MessagePort,
  options: WidgetWorkerOptions = {},
): WidgetWorkerRuntime {
  const endpoint = options.createEndpoint?.(port) ?? createRpc(port);
  const logger = endpoint.getProxy(loggerService);
  void logger
    .write({ level: 'debug', scope: 'widget-runtime', message: 'guest-started', data: [] })
    .catch(() => undefined);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  // The first extra port is the direct device channel: the assembly layer holds the other end, so
  // a publish reaches the device guest and a device publish reaches this runtime without a hop
  // through the host's thread (RFC 0018).
  const devicePort = options.ports?.[0];
  const deviceEndpoint = devicePort === undefined ? undefined : createRpc(devicePort);
  const device = deviceEndpoint?.getProxy(widgetDeviceTopicService);

  const dispatch = (type: string, payload: unknown): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      try {
        listener(payload);
      } catch {
        // A guest listener must not break the host → guest control lane.
      }
    }
  };

  const host = endpoint.getProxy(widgetHostControlService, {
    transfer: (member, args) =>
      member === widgetHostEventMethod && Array.isArray(args[2])
        ? [...(args[2] as readonly Transferable[])]
        : [],
  });

  let disposed = false;
  const runtime = createWidgetRuntime(
    {
      emit(type, payload, transfer) {
        // Synchronous throw once the port is gone, so callers can release transferred resources.
        if (disposed) throw new Error('The widget sandbox is gone');
        void host.event(type, payload, transfer).catch(() => undefined);
      },
      on(type, listener) {
        let set = listeners.get(type);
        if (!set) listeners.set(type, (set = new Set()));
        set.add(listener);
        return () => set.delete(listener);
      },
    },
    { ...options, ...(device === undefined ? {} : { device }) },
  );

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    runtime.dispose();
    endpoint.dispose();
    deviceEndpoint?.dispose();
    try {
      port.close();
    } catch {
      // Already closed.
    }
    try {
      devicePort?.close();
    } catch {
      // Already closed.
    }
  };

  endpoint.register(widgetGuestService, {
    [widgetLoadMethod]: (request: WidgetLoadRequest) => runtime.load(request),
    [widgetMountMethod]: (request: WidgetMountRequest) => runtime.mount(request),
    [widgetUnmountMethod]: (instanceId: string) => runtime.unmount(instanceId),
    [widgetResizeMethod]: (instanceId: string, width: number, height: number, dpr: number) =>
      runtime.resize(instanceId, width, height, dpr),
    [widgetSetPropertiesMethod]: (instanceId: string, props: Readonly<Record<string, unknown>>) =>
      runtime.setProperties(instanceId, props),
    [widgetSetBindingsMethod]: (
      instanceId: string,
      bindings: Readonly<Record<string, CanvasBindingTarget>>,
    ) => runtime.setBindings(instanceId, bindings),
    [widgetDeliverMethod]: (instanceId: string, port: string, payload: unknown, simTime: number) =>
      runtime.deliver(instanceId, port, payload, simTime),
    [widgetPointerMethod]: (instanceId: string, event: WidgetInputEvent) =>
      runtime.pointer(instanceId, event),
    [widgetResetRuntimeMethod]: () => runtime.resetRuntime(),
  });
  endpoint.register(widgetGuestControlService, {
    dispatchEvent: dispatch,
    terminate: dispose,
  });
  endpoint.register(widgetAudioGuestService, {
    attachPort: (port: MessagePort) => runtime.attachAudioPort(port),
    setState: (state: WidgetAudioState) => runtime.setAudioState(state),
  });

  return { runtime, dispose };
}

/** Creates an isolated runtime instance; each sandbox (and each test) gets its own. */
export function createWidgetRuntime(
  channel: WidgetRuntimeChannel,
  options: WidgetRuntimeOptions = {},
): WidgetRuntime {
  const importModule = options.importModule ?? importBlobModule;
  const device = options.device;
  const factories = new Map<string, WidgetFactory>();
  const definitions = new Map<string, WidgetDefinition>();
  const pendingFactories = new Map<string, Promise<WidgetFactory>>();
  const sessions = new Map<string, Session>();
  const dirty = new Set<Session>();
  let scheduled = false;
  let disposed = false;

  const audio: WidgetAudioRuntime = createWidgetAudioRuntime({
    onListenerError: (instanceId, error) => report('deliver', instanceId, error),
  });

  function report(phase: WidgetErrorPhase, instanceId: string, error: unknown): void {
    const payload: WidgetErrorMessage = {
      instanceId,
      phase,
      error: { name: errorName(error), message: errorMessage(error) },
    };
    try {
      channel.emit(widgetErrorEvent, payload);
    } catch {
      // The sandbox is already gone; nothing left to report to.
    }
  }

  /** Hands one device publish to the listeners of one instance port. */
  function deliverToInstance(
    instanceId: string,
    port: string,
    payload: unknown,
    simTime: number,
  ): void {
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
  }

  /**
   * Fans one device publish out to every bound instance port (RFC 0018).
   *
   * Only a guest with a direct device channel receives these calls: the host keeps the same fan-out
   * for guests without one, and the two paths never run together.
   */
  function receiveDevicePublish(publish: SimulationPublish): void {
    if (disposed) return;
    for (const session of [...sessions.values()]) {
      for (const [port, target] of Object.entries(session.bindings)) {
        if (target.symbol !== publish.target.symbol || target.port !== publish.target.port)
          continue;
        deliverToInstance(session.instanceId, port, publish.payload, publish.simTime);
      }
    }
  }

  const unsubscribeDevice = device?.onDidPublish(receiveDevicePublish) ?? (() => {});

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
      channel.emit(widgetFrameEvent, payload, [bitmap]);
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
    // Before the factory runs: `api.audio.state` has to be readable synchronously.
    audio.open(request.instanceId, request.audio);
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
      bindings: {},
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
      channel.emit(widgetAssetFailedEvent, payload);
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
      audio: audio.api(session.instanceId),
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
        // Route before notifying, so the host listener sees a publish whose delivery is in flight.
        const target = session.bindings[port];
        const direct = target !== undefined && device !== undefined;
        if (target !== undefined && device !== undefined) {
          void device.deliver(target, payload, message.simTime).catch((error: unknown) => {
            report('deliver', session.instanceId, error);
          });
        }
        try {
          channel.emit(widgetPublishEvent, direct ? { ...message, direct } : message);
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
    // Voices and streams end with `disposed`; the widget does not have to clean them up.
    audio.release(session.instanceId);
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

    setBindings(instanceId, bindings) {
      const session = sessions.get(instanceId);
      // A host without a direct device channel routes on its own, so a late binding map is no error.
      if (session === undefined) return;
      session.bindings = bindings ?? {};
    },

    deliver(instanceId, port, payload, simTime) {
      deliverToInstance(instanceId, port, payload, simTime);
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

    resetRuntime() {
      if (disposed) return;
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
      unsubscribeDevice();
      dirty.clear();
      for (const session of [...sessions.values()]) {
        release(session);
      }
      sessions.clear();
      audio.dispose();
      factories.clear();
      definitions.clear();
      pendingFactories.clear();
    },

    attachAudioPort(port) {
      audio.attachPort(port);
    },

    setAudioState(state) {
      audio.setState(state);
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

function toWidgetInstance(value: unknown): WidgetImplementation {
  return value && typeof value === 'object' ? (value as WidgetImplementation) : {};
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
