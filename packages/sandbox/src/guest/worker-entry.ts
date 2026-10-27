import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcProxy } from '@mica-js/core/rpc';
import { SandboxError } from '../errors';
import { toCloneableParts } from '../protocol';
import type { SandboxLogLevel, WorkerInitMessage } from '../protocol';
import type { GuestContext, GuestHandler, GuestMethods, GuestSetupResult } from '../types';
import {
  guestControlService,
  guestService,
  hostCapabilitiesService,
  hostControlService,
} from '../internal/services';

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

const TERMINATE_EVENT = 'mica:terminate';
const CONSOLE_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const scope = self as unknown as WorkerScope;
const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const handlers = new Map<string, GuestHandler>();
const guestImplementation: Record<string, (...args: unknown[]) => unknown> = {};
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const abortController = new AbortController();

let rpc: RpcEndpoint | undefined;
let hostCapabilities: RpcProxy<Record<string, (...args: unknown[]) => unknown>> | undefined;
let hostControl: RpcProxy<Record<string, (...args: unknown[]) => unknown>> | undefined;
let pendingDispose: (() => unknown) | undefined;
let disposed = false;

scope.addEventListener('message', (event) => {
  const data = event.data as WorkerInitMessage | undefined;
  if (!data || typeof data !== 'object' || data.type !== 'mica:init') return;
  void boot(data);
});

scope.addEventListener('error', (event) => {
  void hostControl?.guestError?.(event.error ?? new Error(event.message));
});

scope.addEventListener('unhandledrejection', (event) => {
  void hostControl?.guestError?.(event.reason);
});

async function boot(init: WorkerInitMessage): Promise<void> {
  const activeRpc = createRpc(init.port, {
    onError: (error) => nativeConsole.error('[@mica-js/sandbox] RPC error', error),
  });
  rpc = activeRpc;
  hostCapabilities = activeRpc.getProxy(hostCapabilitiesService, {
    timeoutMs: 0,
    transfer: (_member, args) => (args.length > 2 ? (args[2] as readonly Transferable[]) : []),
  });
  hostControl = activeRpc.getProxy(hostControlService);
  activeRpc.register(guestService, guestImplementation);
  activeRpc.register(guestControlService, {
    dispatchEvent: (type: string, payload: unknown) => handleHostEvent(type, payload),
    terminate: () => shutdown(),
  });

  if (init.captureConsole) {
    forwardConsole(activeRpc);
  }
  try {
    const entry = await loadEntry(init.source);
    const ctx = createContext(init);
    const result = await entry.setup(ctx);
    registerSetupResult(result);
    if (entry.dispose) pendingDispose = entry.dispose;
    // The host creates its RPC endpoint after guest services are registered.
    scope.postMessage({ type: 'mica:worker-ready' });
  } catch (error) {
    await hostControl?.bootError?.(error);
    nativeConsole.error('[@mica-js/sandbox] guest failed to start', error);
  }
}

function handleHostEvent(type: string, payload: unknown): void {
  if (type === TERMINATE_EVENT) {
    void shutdown();
    return;
  }

  const subscribers = listeners.get(type);
  if (!subscribers) return;
  for (const listener of [...subscribers]) {
    try {
      listener(payload);
    } catch (error) {
      void hostControl?.guestError?.(error);
    }
  }
}

async function shutdown(): Promise<void> {
  if (disposed) return;
  disposed = true;
  abortController.abort();
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
      guestImplementation[name] = handler as (...args: unknown[]) => unknown;
    },
    invoke(name, ...args) {
      return (requireHostCapabilities()[name] as (...callArgs: unknown[]) => Promise<unknown>)(
        ...args,
      );
    },
    invokeWith(name, args, options = {}) {
      const proxy = createHostCapabilities(options.timeoutMs, options.transfer);
      return (proxy[name] as (...callArgs: unknown[]) => Promise<unknown>)(...args);
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
      void requireHostControl().event!(type, payload, transfer).catch((error: unknown) =>
        hostControl?.guestError?.(error),
      );
    },
    log(...parts) {
      void hostControl?.log?.('info', toCloneableParts(parts));
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
      guestImplementation[name] = value as (...args: unknown[]) => unknown;
    }
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

function forwardConsole(activeRpc: RpcEndpoint): void {
  const proxy = activeRpc.getProxy(hostControlService);
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...parts: unknown[]) => {
      original(...parts);
      void proxy.log!(level as SandboxLogLevel, toCloneableParts(parts));
    };
  }
}

function requireHostCapabilities(): RpcProxy<Record<string, (...args: unknown[]) => unknown>> {
  if (!hostCapabilities) throw new SandboxError('terminated', 'Sandbox runtime is not connected');
  return hostCapabilities;
}

function requireHostControl(): RpcProxy<Record<string, (...args: unknown[]) => unknown>> {
  if (!hostControl) throw new SandboxError('terminated', 'Sandbox runtime is not connected');
  return hostControl;
}

function createHostCapabilities(timeoutMs = 0, transfer?: readonly Transferable[]) {
  return requireHostCapabilitiesEndpoint().getProxy(hostCapabilitiesService, {
    timeoutMs,
    transfer: () => transfer ?? [],
  });
}

function requireHostCapabilitiesEndpoint(): RpcEndpoint {
  if (!rpc) throw new SandboxError('terminated', 'Sandbox runtime is not connected');
  return rpc;
}
