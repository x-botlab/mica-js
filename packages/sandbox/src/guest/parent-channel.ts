import { SandboxError } from '../errors';
import type { PortLike } from '../internal/port';
import { RpcPeer } from '../internal/rpc';
import { CHILD_RESIZE_EVENT } from '../protocol';
import type { ParentSandbox, SandboxRequestOptions, SandboxResizeOptions } from '../types';

/** Host hooks the guest runtime provides to its direct parent channel. */
export interface ParentChannelHandlers {
  /** Dispatches a method the child exported with `$sandbox.export()` / `parent.export()`. */
  onRequest(method: string, args: unknown[]): unknown | Promise<unknown>;
  /** Delivers a public event sent with `child.emit()`. */
  onEvent(type: string, payload: unknown): void;
  /** Handles `child.resize()`. */
  onResize(size: SandboxResizeOptions): void;
  /** Reports a handler failure that has no response channel (notifications, protocol errors). */
  onError(error: unknown): void;
  /** Registers methods exposed by `parent.export()`. */
  exportMethods(methods: Parameters<ParentSandbox['export']>[0]): void;
  /** Subscribes to parent events. */
  subscribe(type: string, listener: (payload: unknown) => void): () => void;
  /** Removes a parent event listener. */
  unsubscribe(type: string, listener: (payload: unknown) => void): void;
}

/**
 * Child-side end of the direct parent↔child `MessagePort`.
 *
 * Speaks the same RPC envelopes as the host channel, but binds them to the guest API: requests
 * from the parent invoke exported methods, parent events reach `$sandbox.on()`, and `invoke` /
 * `emit` travel back to the parent instead of the host.
 */
export class ParentChannel implements ParentSandbox {
  readonly #peer: RpcPeer;
  readonly #handlers: ParentChannelHandlers;

  constructor(port: PortLike, handlers: ParentChannelHandlers) {
    this.#handlers = handlers;
    this.#peer = new RpcPeer(port, {
      onRequest: (method, args) => handlers.onRequest(method, args),
      onEvent: (type, payload) => this.#handleEvent(type, payload),
      onNotify: (method, args) => {
        try {
          void Promise.resolve(handlers.onRequest(method, args)).catch((error: unknown) =>
            handlers.onError(error),
          );
        } catch (error) {
          handlers.onError(error);
        }
      },
      onProtocolError: (error) => handlers.onError(error),
    });
  }

  /** Underlying transport, for the runtime's own bookkeeping. */
  get peer(): RpcPeer {
    return this.#peer;
  }

  export(methods: Parameters<ParentSandbox['export']>[0]): void {
    this.#handlers.exportMethods(methods);
  }

  invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    return this.#peer.request(name, args) as Promise<T>;
  }

  invokeWith<T = unknown>(
    name: string,
    args: readonly unknown[],
    options: SandboxRequestOptions = {},
  ): Promise<T> {
    return this.#peer.request(name, args, options) as Promise<T>;
  }

  notify(method: string, args: readonly unknown[] = [], transfer?: readonly Transferable[]): void {
    this.#peer.notify(method, args, transfer);
  }

  emit(type: string, payload?: unknown, transfer?: readonly Transferable[]): void {
    this.#peer.emit(type, payload, transfer);
  }

  on(type: string, listener: (payload: unknown) => void): () => void {
    return this.#handlers.subscribe(type, listener);
  }

  off(type: string, listener: (payload: unknown) => void): void {
    this.#handlers.unsubscribe(type, listener);
  }

  /** Forwards an uncaught guest error to the parent. */
  reportError(error: unknown): void {
    this.#peer.postGuestError(error);
  }

  destroy(reason: string): void {
    this.#peer.destroy(new SandboxError('terminated', reason));
  }

  #handleEvent(type: string, payload: unknown): void {
    if (type === CHILD_RESIZE_EVENT) {
      this.#handlers.onResize(asResize(payload));
      return;
    }
    // Reserved names are runtime-internal: a parent cannot deliver them as public events.
    if (type.startsWith('mica:')) return;
    this.#handlers.onEvent(type, payload);
  }
}

function asResize(payload: unknown): SandboxResizeOptions {
  if (typeof payload !== 'object' || payload === null) return { width: 1, height: 1 };
  const size = payload as { width?: unknown; height?: unknown; dpr?: unknown };
  const resize: SandboxResizeOptions = {
    width: typeof size.width === 'number' ? size.width : 1,
    height: typeof size.height === 'number' ? size.height : 1,
  };
  if (typeof size.dpr === 'number') resize.dpr = size.dpr;
  return resize;
}
