import { SandboxError } from '../errors';
import { createDeferred, withTimeout } from '../internal/deferred';
import type { Deferred } from '../internal/deferred';
import type {
  FrameToHostMessage,
  HostToFrameMessage,
  WorkerErrorMessage,
  WorkerMessageErrorMessage,
  WorkerMessageMessage,
} from '../protocol';
import type {
  SandboxPostMessageOptions,
  SandboxState,
  SandboxWorker as SandboxWorkerApi,
  SandboxWorkerError,
  SandboxWorkerOptions,
} from '../types';
import type { NormalizedOptions } from './options';
import { assertBrowserEnvironment, normalizeOptions } from './options';
import { applyCspOverride, buildFrameCsp, generateNonce } from './csp';
import { buildFrameDocument } from './frame-document';
import { assignSrcdoc, detectNonce } from './trusted-types';

/**
 * Runs one self-contained worker script — normally a bundler output — inside an offscreen iframe,
 * so the guest has an opaque origin and no DOM, storage or network access.
 *
 * The iframe only bootstraps the worker: it creates it from the caller's code and forwards
 * ordinary messages and worker events across the frame boundary.
 */
export class SandboxWorker implements SandboxWorkerApi {
  readonly id: string;
  readonly name: string;
  readonly ready: Promise<void>;
  readonly #code: string;
  readonly #options: NormalizedOptions;
  readonly #frameReady: Deferred<void>;
  readonly #readyState: Deferred<void>;
  readonly #errorListeners = new Set<(error: SandboxWorkerError) => void>();
  readonly #eventListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly #pendingMessages: Array<{ message: unknown; transfer: Transferable[] }> = [];
  #frameDocument: string | undefined;
  #iframe: HTMLIFrameElement | undefined;
  #state: SandboxState = 'ready';
  #workerStarted = false;
  #termination: Promise<void> | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor(code: string, options: SandboxWorkerOptions = {}) {
    assertBrowserEnvironment();
    this.#code = code;
    this.#options = normalizeOptions(code, options);
    this.id = `mica-sandbox-${this.#options.name}`;
    this.name = this.#options.name;
    this.#frameReady = createDeferred<void>();
    this.#readyState = createDeferred<void>();
    this.ready = this.#readyState.promise;
    void this.#boot().catch((error) => this.#readyState.reject(error));
  }

  get state(): SandboxState {
    return this.#state;
  }

  postMessage(message: unknown, options?: SandboxPostMessageOptions): void {
    if (this.#state === 'terminated') {
      throw new SandboxError('terminated', `Sandbox "${this.name}" is terminated`);
    }
    const transfer =
      options === undefined
        ? []
        : Array.isArray(options)
          ? [...options]
          : ((options as StructuredSerializeOptions).transfer ?? []).slice();
    const target = this.#iframe?.contentWindow;
    if (!target || !this.#workerStarted) {
      this.#pendingMessages.push({ message, transfer });
      return;
    }
    target.postMessage(message, '*', transfer);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: EventListenerOrEventListenerObject,
    // Kept for the Worker-shaped signature; the sandbox forwards every message to each listener.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options?: boolean | AddEventListenerOptions,
  ): void {
    let listeners = this.#eventListeners.get(type);
    if (!listeners) this.#eventListeners.set(type, (listeners = new Set()));
    listeners.add(listener);
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: EventListenerOrEventListenerObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options?: boolean | EventListenerOptions,
  ): void {
    this.#eventListeners.get(type)?.delete(listener);
  }

  onError(listener: (error: SandboxWorkerError) => void): () => void {
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  async #boot(): Promise<void> {
    const options = this.#options;
    if (options.frameUrl === undefined) {
      const nonce = options.nonce ?? detectNonce() ?? generateNonce();
      const csp = applyCspOverride(buildFrameCsp({ nonce }), options.csp);
      this.#frameDocument = buildFrameDocument({ csp, nonce });
    }

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.tabIndex = -1;
    frame.title = `Mica sandbox: ${options.name}`;
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    this.#iframe = frame;
    if (options.frameUrl !== undefined) frame.src = options.frameUrl;
    else assignSrcdoc(frame, this.#frameDocument ?? '', options.trustedTypesPolicy);

    window.addEventListener('message', this.#onWindowMessage);
    (options.container ?? document.body).append(frame);
    try {
      await withTimeout(this.#frameReady.promise, options.bootTimeoutMs, () =>
        this.#bootTimeoutError(),
      );
      this.#startWorker();
      await withTimeout(this.#readyState.promise, options.bootTimeoutMs, () =>
        this.#bootTimeoutError(),
      );
    } catch (error) {
      const failure =
        error instanceof SandboxError
          ? error
          : new SandboxError('boot-failed', `Sandbox "${options.name}" failed to boot`, {
              cause: error,
            });
      // Settle `ready` with the real cause before tearing the frame down.
      this.#readyState.reject(failure);
      await this.terminate('boot failed');
      throw failure;
    }
  }

  terminate(reason = 'disposed'): Promise<void> {
    if (this.#termination) return this.#termination;
    const error = new SandboxError('terminated', `Sandbox "${this.name}" terminated: ${reason}`);
    this.#termination = Promise.resolve().then(() => {
      this.#state = 'terminated';
      this.#errorListeners.clear();
      this.#eventListeners.clear();
      this.#readyState.reject(error);
      this.#frameReady.reject(error);
      this.#pendingMessages.length = 0;
      window.removeEventListener('message', this.#onWindowMessage);
      const frame = this.#iframe;
      this.#iframe = undefined;
      try {
        frame?.contentWindow?.postMessage(
          { type: 'mica:terminate', control: true } satisfies HostToFrameMessage,
          '*',
        );
      } catch {
        // The frame is already gone.
      }
      frame?.remove();
    });
    return this.#termination;
  }

  #startWorker(): void {
    const target = this.#iframe?.contentWindow;
    if (!target) {
      throw new SandboxError('boot-failed', `Sandbox "${this.name}" has no frame window`);
    }
    const message: HostToFrameMessage = { type: 'mica:boot', code: this.#code };
    target.postMessage(message, '*');
  }

  #flushMessages(): void {
    const target = this.#iframe?.contentWindow;
    if (!target) return;
    for (const pending of this.#pendingMessages.splice(0)) {
      target.postMessage(pending.message, '*', pending.transfer);
    }
  }

  #onWindowMessage = (event: MessageEvent): void => {
    const frame = this.#iframe;
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as FrameToHostMessage | null;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'mica:frame-ready') {
      this.#frameReady.resolve();
    } else if (data.type === 'mica:worker-started') {
      this.#workerStarted = true;
      this.#readyState.resolve();
      this.#flushMessages();
    } else if (data.type === 'mica:frame-error') {
      this.#readyState.reject(new SandboxError('boot-failed', data.message));
    } else if (data.type === 'mica:worker-error') {
      this.#reportWorkerError(data);
    } else if (data.type === 'mica:worker-message') {
      this.#dispatchMessage('message', data, event.ports);
    } else if (data.type === 'mica:worker-messageerror') {
      this.#dispatchMessage('messageerror', data, event.ports);
    }
  };

  #dispatchMessage(
    type: 'message' | 'messageerror',
    message: WorkerMessageMessage | WorkerMessageErrorMessage,
    ports: readonly MessagePort[],
  ): void {
    this.#dispatchEvent(type, createMessageEvent(type, message.data, ports));
  }

  #dispatchEvent(type: 'message' | 'messageerror' | 'error', event: Event): void {
    const property =
      type === 'message'
        ? this.onmessage
        : type === 'messageerror'
          ? this.onmessageerror
          : this.onerror;
    if (property) {
      try {
        property(event as never);
      } catch (listenerError) {
        console.error(`[@mica-js/sandbox] ${type} listener threw`, listenerError);
      }
    }
    for (const listener of [...(this.#eventListeners.get(type) ?? [])]) {
      try {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      } catch (listenerError) {
        console.error(`[@mica-js/sandbox] ${type} listener threw`, listenerError);
      }
    }
  }

  #reportWorkerError(message: WorkerErrorMessage): void {
    const error: SandboxWorkerError = {
      message: message.message,
      filename: message.filename,
      lineno: message.lineno,
      colno: message.colno,
    };
    // A worker that throws while starting fails `ready`; rejecting a settled deferred is a no-op.
    this.#readyState.reject(new SandboxError('boot-failed', error.message));
    const hasErrorListener =
      this.#errorListeners.size > 0 ||
      this.onerror !== null ||
      (this.#eventListeners.get('error')?.size ?? 0) > 0;
    this.#dispatchEvent('error', createErrorEvent(error));
    for (const listener of [...this.#errorListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        console.error('[@mica-js/sandbox] onError listener threw', listenerError);
      }
    }
    if (!hasErrorListener) {
      console.error(`[@mica-js/sandbox] worker "${this.name}" failed: ${error.message}`);
    }
  }

  #bootTimeoutError(): SandboxError {
    return new SandboxError('boot-timeout', `Sandbox "${this.name}" did not become ready in time`);
  }
}

function createMessageEvent(
  type: 'message' | 'messageerror',
  data: unknown,
  ports: readonly MessagePort[],
): MessageEvent {
  try {
    return new MessageEvent(type, { data, ports: [...ports] });
  } catch {
    return { type, data, ports: [...ports] } as unknown as MessageEvent;
  }
}

function createErrorEvent(error: SandboxWorkerError): ErrorEvent {
  try {
    return new ErrorEvent('error', {
      message: error.message,
      ...(error.filename === undefined ? {} : { filename: error.filename }),
      ...(error.lineno === undefined ? {} : { lineno: error.lineno }),
      ...(error.colno === undefined ? {} : { colno: error.colno }),
    });
  } catch {
    return { type: 'error', ...error } as ErrorEvent;
  }
}
