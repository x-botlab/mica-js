import { SandboxError } from '../errors';
import type { PortLike } from '../internal/port';
import { RpcPeer } from '../internal/rpc';
import type { RequestOptions } from '../internal/rpc';
import { CHILD_RESIZE_EVENT, CHILD_SANDBOX_METHODS, CHILD_TERMINATED_EVENT } from '../protocol';
import type {
  ChildSandboxRequest,
  ChildSandboxResponse,
  ChildTerminateRequest,
  ChildTerminatedPayload,
  SandboxInfo,
} from '../protocol';
import type {
  ChildSandboxOptions,
  SandboxCapabilities,
  SandboxContract,
  SandboxHandle,
  SandboxRequestOptions,
  SandboxResizeOptions,
  SandboxState,
} from '../types';

/** Transport the parent guest uses to reach the host (creation and termination only). */
export interface ChildSandboxLink {
  request(
    method: string,
    args: readonly unknown[],
    transfer?: readonly Transferable[],
  ): Promise<unknown>;
  notify(method: string, args: readonly unknown[], transfer?: readonly Transferable[]): void;
  /** Subscribes to a host event; returns an unsubscribe function. */
  on(type: string, listener: (payload: unknown) => void): () => void;
}

/**
 * Holds the capability functions a parent guest registered for its children.
 *
 * They live in the parent guest and never cross the boundary: the child calls them over the
 * direct `MessagePort`, so they are never serialized.
 */
export class ChildCapabilityRegistry {
  readonly #entries = new Map<string, SandboxCapabilities>();

  register(name: string, capabilities: SandboxCapabilities | undefined): void {
    if (capabilities && Object.keys(capabilities).length > 0) this.#entries.set(name, capabilities);
  }

  remove(name: string): void {
    this.#entries.delete(name);
  }

  clear(): void {
    this.#entries.clear();
  }

  async invoke(name: string, capability: string, args: readonly unknown[]): Promise<unknown> {
    const capabilities = this.#entries.get(name);
    if (!capabilities) {
      throw new SandboxError(
        'capability-not-found',
        `No capabilities are registered for child sandbox "${name}"`,
      );
    }
    const handler = capabilities[capability];
    if (!handler) {
      throw new SandboxError(
        'capability-not-found',
        `Child sandbox "${name}" called unknown capability "${capability}"`,
      );
    }
    return (handler as unknown as (...callArgs: unknown[]) => unknown)(...args);
  }
}

/** Validates guest options and strips everything that cannot cross the boundary. */
export function serializeChildOptions(options: ChildSandboxOptions): ChildSandboxRequest {
  if (typeof options !== 'object' || options === null) {
    throw invalid('`$sandbox.createChildSandbox()` needs an options object');
  }
  const name = options.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw invalid('`name` must be a non-empty string');
  }
  if (options.canvas !== undefined) {
    throw invalid(
      '`canvas` cannot cross the sandbox boundary: guests have no DOM. ' +
        'Hosts composite child frames through the `resolveChildCanvas` option',
    );
  }

  const source = options.source;
  if (typeof source !== 'object' || source === null) throw invalid('`source` is required');
  if (source.type !== 'module' && source.type !== 'script') {
    throw invalid("`source.type` must be 'module' or 'script'");
  }
  if ('code' in source) {
    if (typeof source.code !== 'string' || source.code.trim() === '') {
      throw invalid('`source.code` must be a non-empty string');
    }
  } else if (typeof source.url !== 'string' || source.url.trim() === '') {
    throw invalid('`source.url` must be a non-empty string');
  }

  const capabilities = options.capabilities ?? {};
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw invalid('`capabilities` must be an object');
  }
  for (const [capability, handler] of Object.entries(capabilities)) {
    if (typeof handler !== 'function') {
      throw invalid(`Capability "${capability}" must be a function`);
    }
  }

  const request: ChildSandboxRequest = {
    name,
    source,
  };
  if (options.maxFps !== undefined) request.maxFps = options.maxFps;
  if (options.captureConsole !== undefined) request.captureConsole = options.captureConsole;
  if (options.callTimeoutMs !== undefined) request.callTimeoutMs = options.callTimeoutMs;
  return request;
}

/**
 * Creates a child sandbox and returns a handle backed by the direct parent↔child `MessagePort`.
 *
 * Only creation and termination touch the host. Everything else (`call`, `request`, `notify`,
 * `emit`, events, and capability lookups performed by the child) stays on the port.
 */
export async function createChildSandbox<T extends SandboxContract = SandboxContract>(
  options: ChildSandboxOptions,
  link: ChildSandboxLink,
  registry: ChildCapabilityRegistry,
): Promise<SandboxHandle<T>> {
  const request = serializeChildOptions(options);
  registry.register(request.name, options.capabilities);

  let response: ChildSandboxResponse;
  try {
    response = readResponse(await link.request(CHILD_SANDBOX_METHODS.create, [request]));
  } catch (error) {
    registry.remove(request.name);
    throw error;
  }

  const defaultTimeoutMs = request.callTimeoutMs ?? 0;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let terminated = response.state === 'terminated';

  const terminationError = (): SandboxError =>
    new SandboxError('terminated', `Child sandbox "${response.name}" is terminated`);

  const destroyPort = (reason: string): void => {
    if (terminated) return;
    terminated = true;
    registry.remove(response.name);
    peer.destroy(new SandboxError('terminated', reason));
  };

  const dispatch = (type: string, payload: unknown): void => {
    // Reserved names belong to the runtime; a child cannot deliver them as public events.
    if (type.startsWith('mica:')) return;
    const subscribers = listeners.get(type);
    if (!subscribers) return;
    for (const listener of [...subscribers]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[@mica-js/sandbox] child listener for "${type}" threw`, error);
      }
    }
  };

  const peer = new RpcPeer(asPort(response.port), {
    onRequest: (method, args) => registry.invoke(response.name, method, args),
    onEvent: (type, payload) => dispatch(type, payload),
    onGuestError: (error) => dispatch('error', error),
    onNotify: (method, args) => {
      void registry.invoke(response.name, method, args).catch((error: unknown) => {
        dispatch('error', error);
      });
    },
    onProtocolError: (error) => dispatch('error', error),
  });

  const off = (type: string, listener: (payload: unknown) => void): void => {
    listeners.get(type)?.delete(listener);
  };

  const on = (type: string, listener: (payload: unknown) => void): (() => void) => {
    assertEventName(type);
    if (typeof listener !== 'function') throw invalid('`on()` needs a listener function');
    let subscribers = listeners.get(type);
    if (!subscribers) {
      subscribers = new Set();
      listeners.set(type, subscribers);
    }
    subscribers.add(listener);
    return () => off(type, listener);
  };

  const send = (
    method: string,
    args: readonly unknown[] = [],
    callOptions: SandboxRequestOptions = {},
  ): Promise<unknown> => {
    if (terminated) return Promise.reject(terminationError());
    const requestOptions: RequestOptions = {
      timeoutMs: callOptions.timeoutMs ?? defaultTimeoutMs,
    };
    if (callOptions.transfer !== undefined) requestOptions.transfer = callOptions.transfer;
    return peer.request(method, args, requestOptions);
  };

  // The host mirrors terminations it performs itself (parent shutdown, host-side cleanup) so the
  // parent handle stops reporting a live child.
  link.on(CHILD_TERMINATED_EVENT, (payload) => {
    const terminatedChild = payload as Partial<ChildTerminatedPayload> | null;
    if (!terminatedChild || terminatedChild.childId !== response.childId) return;
    destroyPort(terminatedChild.reason ?? 'terminated');
  });

  return {
    id: response.childId,
    name: response.name,
    get state(): SandboxState {
      return terminated ? 'terminated' : response.state;
    },
    info: response.info,
    canvas: undefined,
    call<M extends keyof T & string>(
      method: M,
      ...args: Parameters<T[M]>
    ): Promise<Awaited<ReturnType<T[M]>>> {
      return send(method, args) as Promise<Awaited<ReturnType<T[M]>>>;
    },
    request: send,
    notify(method, args = [], transfer) {
      if (terminated) return;
      peer.notify(method, args, transfer);
    },
    emit(type, payload, transfer) {
      assertPublicEventName(type);
      if (terminated) return;
      peer.emit(type, payload, transfer);
    },
    on,
    off,
    resize(size: SandboxResizeOptions) {
      if (terminated) return;
      peer.emit(CHILD_RESIZE_EVENT, size);
    },
    async terminate(reason) {
      if (terminated) return;
      const message: ChildTerminateRequest = { childId: response.childId };
      if (reason !== undefined) message.reason = reason;
      destroyPort(reason ?? 'terminated by parent');
      try {
        await link.request(CHILD_SANDBOX_METHODS.terminate, [message]);
      } catch (error) {
        // The parent is already gone: cleanup must stay idempotent.
        if (!(error instanceof SandboxError && error.code === 'terminated')) throw error;
      }
    },
  };
}

function readResponse(value: unknown): ChildSandboxResponse {
  if (typeof value !== 'object' || value === null) {
    throw new SandboxError('protocol', 'Host did not return a child sandbox descriptor');
  }
  const record = value as Partial<ChildSandboxResponse>;
  if (typeof record.childId !== 'string' || record.childId === '') {
    throw new SandboxError('protocol', 'Child sandbox descriptor has no id');
  }
  if (!isPortLike(record.port)) {
    throw new SandboxError('protocol', 'Child sandbox descriptor has no parent port');
  }
  if (typeof record.info !== 'object' || record.info === null) {
    throw new SandboxError('protocol', 'Child sandbox descriptor has no info');
  }
  return {
    childId: record.childId,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : record.childId,
    state: record.state === 'terminated' ? 'terminated' : 'ready',
    info: record.info as SandboxInfo,
    port: record.port,
  };
}

function isPortLike(value: unknown): value is MessagePort {
  if (typeof value !== 'object' || value === null) return false;
  const port = value as Partial<MessagePort>;
  return typeof port.postMessage === 'function' && typeof port.addEventListener === 'function';
}

function asPort(port: MessagePort): PortLike {
  return port as unknown as PortLike;
}

function assertEventName(type: string): string {
  if (typeof type !== 'string' || type === '') {
    throw invalid('Event names must be non-empty strings');
  }
  return type;
}

function assertPublicEventName(type: string): void {
  assertEventName(type);
  if (type.startsWith('mica:')) {
    throw invalid('Event names starting with "mica:" are reserved');
  }
}

function invalid(message: string): SandboxError {
  return new SandboxError('invalid-options', message);
}
