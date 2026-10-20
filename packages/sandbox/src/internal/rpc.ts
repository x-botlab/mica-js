import { SandboxError, deserializeError } from '../errors';
import { isEnvelope, serializeError, toCloneableParts } from '../protocol';
import type { Envelope, SandboxInfo, SandboxLogLevel } from '../protocol';
import type { PortLike, PortMessageEvent } from './port';
import { unpackTransfer } from './transfer';

export interface RpcHandlers {
  onRequest(method: string, args: unknown[]): unknown | Promise<unknown>;
  onEvent(type: string, payload: unknown): void;
  onNotify?(method: string, args: unknown[]): void;
  onLog?(level: SandboxLogLevel, parts: unknown[]): void;
  onGuestError?(error: unknown): void;
  onReady?(info: SandboxInfo): void;
  onBootError?(error: unknown): void;
  /** Receives malformed or undeliverable messages instead of throwing into the event loop. */
  onProtocolError?(error: SandboxError): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface RequestOptions {
  transfer?: readonly Transferable[];
  timeoutMs?: number;
}

/**
 * Bidirectional request/response + event transport over a single port. Both ends run the same
 * class: request ids are scoped per side, responses are routed to the matching pending request.
 */
export class RpcPeer {
  readonly #port: PortLike;
  readonly #handlers: RpcHandlers;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  constructor(port: PortLike, handlers: RpcHandlers) {
    this.#port = port;
    this.#handlers = handlers;
    this.#port.addEventListener('message', this.#onMessage);
    this.#port.start?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(
    method: string,
    args: readonly unknown[] = [],
    options: RequestOptions = {},
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new SandboxError('terminated', 'Sandbox is terminated'));
    }

    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 0;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#settle(id);
              reject(
                new SandboxError('timeout', `Sandbox call "${method}" exceeded ${timeoutMs}ms`),
              );
            }, timeoutMs)
          : undefined;

      this.#pending.set(id, { resolve, reject, timer });

      try {
        this.#post({ k: 'request', id, method, args: [...args] }, options.transfer);
      } catch (error) {
        this.#settle(id);
        reject(
          new SandboxError('protocol', `Failed to send "${method}": ${describe(error)}`, {
            cause: error,
          }),
        );
      }
    });
  }

  notify(method: string, args: readonly unknown[] = [], transfer?: readonly Transferable[]): void {
    this.#post({ k: 'notify', method, args: [...args] }, transfer);
  }

  emit(type: string, payload?: unknown, transfer?: readonly Transferable[]): void {
    this.#post({ k: 'event', type, payload }, transfer);
  }

  postLog(level: SandboxLogLevel, parts: readonly unknown[]): void {
    this.#post({ k: 'log', level, parts: toCloneableParts(parts) });
  }

  postReady(info: SandboxInfo): void {
    this.#post({ k: 'ready', info });
  }

  postBootError(error: unknown): void {
    this.#post({ k: 'boot-error', error: serializeError(error) });
  }

  postGuestError(error: unknown): void {
    this.#post({ k: 'guest-error', error: serializeError(error) });
  }

  destroy(reason: SandboxError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.removeEventListener('message', this.#onMessage);
    this.closePending(reason);
    this.#port.close?.();
  }

  /** Rejects in-flight requests but keeps the port usable for a last message. */
  closePending(reason: SandboxError): void {
    for (const [id, pending] of this.#pending) {
      this.#settle(id);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #post(envelope: Envelope, transfer?: readonly Transferable[]): void {
    if (this.#closed) return;
    this.#port.postMessage(envelope, transfer ? [...transfer] : undefined);
  }

  #settle(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#pending.delete(id);
  }

  #onMessage = (event: PortMessageEvent): void => {
    if (this.#closed) return;
    const data = event.data;
    if (!isEnvelope(data)) {
      this.#reportProtocol('Received a message that is not a sandbox envelope');
      return;
    }

    switch (data.k) {
      case 'request':
        void this.#handleRequest(data.id, data.method, data.args);
        return;
      case 'response':
        this.#handleResponse(data);
        return;
      case 'event':
        this.#invokeHandler(() => this.#handlers.onEvent(data.type, data.payload));
        return;
      case 'notify':
        this.#invokeHandler(() => this.#handlers.onNotify?.(data.method, data.args));
        return;
      case 'log':
        this.#invokeHandler(() => this.#handlers.onLog?.(data.level, data.parts));
        return;
      case 'guest-error':
        this.#invokeHandler(() => this.#handlers.onGuestError?.(deserializeError(data.error)));
        return;
      case 'ready':
        this.#invokeHandler(() => this.#handlers.onReady?.(data.info));
        return;
      case 'boot-error':
        this.#invokeHandler(() => this.#handlers.onBootError?.(deserializeError(data.error)));
        return;
    }
  };

  async #handleRequest(id: number, method: string, args: unknown[]): Promise<void> {
    if (this.#closed) return;

    try {
      const { value, transfer } = unpackTransfer(await this.#handlers.onRequest(method, args));
      try {
        this.#post({ k: 'response', id, ok: true, value }, transfer);
      } catch (error) {
        this.#post({
          k: 'response',
          id,
          ok: false,
          error: serializeError(
            new SandboxError('protocol', `Return value of "${method}" cannot be cloned`, {
              cause: error,
            }),
          ),
        });
      }
    } catch (error) {
      this.#post({ k: 'response', id, ok: false, error: serializeError(error) });
    }
  }

  #handleResponse(data: Extract<Envelope, { k: 'response' }>): void {
    const pending = this.#pending.get(data.id);
    if (!pending) return;
    this.#settle(data.id);
    if (data.ok) pending.resolve(data.value);
    else pending.reject(deserializeError(data.error));
  }

  #invokeHandler(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#reportProtocol(`Sandbox handler threw: ${describe(error)}`);
    }
  }

  #reportProtocol(message: string): void {
    try {
      this.#handlers.onProtocolError?.(new SandboxError('protocol', message));
    } catch {
      // Nothing sensible left to do: reporting failed.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
