import { SandboxError } from '../errors';
import { RpcPeer } from '../internal/rpc';
import type { SandboxInfo, SandboxLogLevel, SurfaceGeometry, WorkerInitMessage } from '../protocol';
import type {
  GuestContext,
  GuestHandler,
  GuestMethods,
  GuestSetupResult,
  GuestSurface,
  GuestSurfaceOptions,
} from '../types';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: 'unhandledrejection',
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  [key: string]: unknown;
}

declare function importScripts(...urls: string[]): void;

type GuestSetup = (ctx: GuestContext) => GuestSetupResult;

const FRAME_EVENT = 'mica:frame';
const SURFACE_EVENT = 'mica:surface';
const TERMINATE_EVENT = 'mica:terminate';
const CONSOLE_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const scope = self as unknown as WorkerScope;
const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const handlers = new Map<string, GuestHandler>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const surfaces = new Set<GuestSurfaceImpl>();
const abortController = new AbortController();

let peer: RpcPeer | undefined;
let surfaceGeometry: SurfaceGeometry = { width: 300, height: 150, dpr: 1 };
let pendingDispose: (() => unknown) | undefined;
let disposed = false;

scope.addEventListener('message', (event) => {
  const data = event.data as WorkerInitMessage | undefined;
  if (!data || typeof data !== 'object' || data.type !== 'mica:init') return;
  void boot(data);
});

scope.addEventListener('error', (event) => {
  peer?.postGuestError(event.error ?? new Error(event.message));
});

scope.addEventListener('unhandledrejection', (event) => {
  peer?.postGuestError(event.reason);
});

async function boot(init: WorkerInitMessage): Promise<void> {
  surfaceGeometry = init.surface;

  const activePeer = new RpcPeer(init.port, {
    onRequest: (method, args) => dispatch(method, args),
    onEvent: (type, payload) => handleHostEvent(type, payload),
    onNotify: (method, args) => {
      void dispatch(method, args).catch((error: unknown) => activePeer.postGuestError(error));
    },
  });
  peer = activePeer;

  if (init.captureConsole) {
    forwardConsole(activePeer);
  }

  try {
    const entry = await loadEntry(init.source);
    const ctx = createContext(init);
    const result = await entry.setup(ctx);
    registerSetupResult(result);
    if (entry.dispose) pendingDispose = entry.dispose;
    activePeer.postReady(buildInfo(init));
    // Tells the frame that startup finished, so later uncaught errors are not reported twice.
    scope.postMessage({ type: 'mica:worker-ready' });
  } catch (error) {
    activePeer.postBootError(error);
    nativeConsole.error('[@mica-js/sandbox] guest failed to start', error);
  }
}

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(method);
  if (!handler) {
    throw new SandboxError('method-not-found', `Guest does not expose "${method}"`);
  }
  return (handler as unknown as (...callArgs: unknown[]) => unknown)(...args);
}

function handleHostEvent(type: string, payload: unknown): void {
  if (type === TERMINATE_EVENT) {
    void shutdown();
    return;
  }

  if (type === SURFACE_EVENT) {
    const next = payload as SurfaceGeometry | null;
    if (next && typeof next.width === 'number' && typeof next.height === 'number') {
      surfaceGeometry = next;
      for (const surface of surfaces) surface.applyHostGeometry(next);
    }
    return;
  }

  const subscribers = listeners.get(type);
  if (!subscribers) return;
  for (const listener of [...subscribers]) {
    try {
      listener(payload);
    } catch (error) {
      peer?.postGuestError(error);
    }
  }
}

async function shutdown(): Promise<void> {
  if (disposed) return;
  disposed = true;
  abortController.abort();
  for (const surface of surfaces) surface.dispose();
  surfaces.clear();
  try {
    await pendingDispose?.();
  } catch (error) {
    nativeConsole.error('[@mica-js/sandbox] guest dispose() threw', error);
  }
}

function createContext(init: WorkerInitMessage): GuestContext {
  return {
    id: init.id,
    name: init.name,
    signal: abortController.signal,
    handle(name, handler) {
      if (typeof name !== 'string' || name === '') {
        throw new SandboxError('invalid-options', 'Method names must be non-empty strings');
      }
      if (typeof handler !== 'function') {
        throw new SandboxError('invalid-options', `Handler for "${name}" must be a function`);
      }
      handlers.set(name, handler);
    },
    invoke(name, ...args) {
      return requirePeer().request(name, args);
    },
    invokeWith(name, args, options = {}) {
      return requirePeer().request(name, args, options);
    },
    on(type, listener) {
      let subscribers = listeners.get(type);
      if (!subscribers) {
        subscribers = new Set();
        listeners.set(type, subscribers);
      }
      subscribers.add(listener);
      return () => {
        listeners.get(type)?.delete(listener);
      };
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, payload, transfer) {
      requirePeer().emit(type, payload, transfer);
    },
    log(...parts) {
      peer?.postLog('info', parts);
    },
    createSurface(options: GuestSurfaceOptions = {}) {
      const surface = new GuestSurfaceImpl(options);
      surfaces.add(surface);
      return surface;
    },
  };
}

function registerSetupResult(result: GuestSetupResult | GuestMethods | undefined): void {
  if (!result) return;
  if (typeof result === 'function') {
    pendingDispose = result as () => unknown;
    return;
  }
  if (typeof result !== 'object') return;

  for (const [name, value] of Object.entries(result)) {
    if (typeof value === 'function') {
      handlers.set(name, value as GuestHandler);
    }
  }
}

class GuestSurfaceImpl implements GuestSurface {
  readonly canvas: OffscreenCanvas;
  readonly #autoSize: boolean;
  #dpr: number;
  #disposed = false;

  constructor(options: GuestSurfaceOptions) {
    const width = options.width ?? surfaceGeometry.width;
    const height = options.height ?? surfaceGeometry.height;
    this.#dpr = options.dpr ?? surfaceGeometry.dpr;
    this.#autoSize = options.width === undefined && options.height === undefined;
    this.canvas = new OffscreenCanvas(
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
    );
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  get dpr(): number {
    return this.#dpr;
  }

  commit(): void {
    const activePeer = peer;
    if (this.#disposed || !activePeer) return;

    const bitmap = this.canvas.transferToImageBitmap();
    const geometry: SurfaceGeometry = {
      width: this.canvas.width,
      height: this.canvas.height,
      dpr: this.#dpr,
    };
    try {
      activePeer.emit(FRAME_EVENT, { bitmap, geometry }, [bitmap]);
    } catch {
      bitmap.close();
    }
  }

  resize(width: number, height: number, dpr?: number): void {
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
    if (dpr !== undefined) this.#dpr = dpr;
  }

  applyHostGeometry(next: SurfaceGeometry): void {
    if (!this.#autoSize) return;
    this.resize(next.width, next.height, next.dpr);
  }

  dispose(): void {
    this.#disposed = true;
  }
}

async function loadEntry(
  source: WorkerInitMessage['source'],
): Promise<{ setup: GuestSetup; dispose?: () => unknown }> {
  const url = URL.createObjectURL(new Blob([source.code], { type: 'text/javascript' }));
  try {
    if (source.type === 'module') {
      const module = (await importGuestModule(url)) as {
        setup?: unknown;
        default?: unknown;
        dispose?: unknown;
      };
      const setup = module.setup ?? module.default;
      if (typeof setup !== 'function') {
        throw new SandboxError('boot-failed', 'Guest module must export `setup(ctx)`');
      }
      return typeof module.dispose === 'function'
        ? { setup: setup as GuestSetup, dispose: module.dispose as () => unknown }
        : { setup: setup as GuestSetup };
    }

    importScripts(url);
    const candidate = scope[source.globalName];
    if (typeof candidate === 'function') {
      return { setup: candidate as GuestSetup };
    }
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      if (typeof record.setup === 'function') {
        return typeof record.dispose === 'function'
          ? { setup: record.setup as GuestSetup, dispose: record.dispose as () => unknown }
          : { setup: record.setup as GuestSetup };
      }
    }
    throw new SandboxError(
      'boot-failed',
      `Classic script must define \`self.${source.globalName}\` with a \`setup(ctx)\` function`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function importGuestModule(url: string): Promise<unknown> {
  // Kept dynamic: the module is a blob created from guest source at runtime.
  return import(/* @vite-ignore */ url) as Promise<unknown>;
}

function forwardConsole(activePeer: RpcPeer): void {
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...parts: unknown[]) => {
      original(...parts);
      activePeer.postLog(level as SandboxLogLevel, parts);
    };
  }
}

function buildInfo(init: WorkerInitMessage): SandboxInfo {
  return {
    name: init.name,
    origin: readOrigin(),
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    guestMethods: [...handlers.keys()],
    features: detectFeatures(),
  };
}

function readOrigin(): string {
  const origin = scope['origin'];
  return typeof origin === 'string' ? origin : 'null';
}

function detectFeatures(): SandboxInfo['features'] {
  const offscreenCanvas = typeof OffscreenCanvas === 'function';
  let webgl2 = false;
  if (offscreenCanvas) {
    try {
      webgl2 = Boolean(new OffscreenCanvas(1, 1).getContext('webgl2'));
    } catch {
      webgl2 = false;
    }
  }
  return { wasm: typeof WebAssembly === 'object', offscreenCanvas, webgl2 };
}

function requirePeer(): RpcPeer {
  if (!peer) throw new SandboxError('terminated', 'Sandbox runtime is not connected');
  return peer;
}
