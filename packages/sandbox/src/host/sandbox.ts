import { SandboxError } from '../errors';
import { createDeferred, withTimeout } from '../internal/deferred';
import type { Deferred } from '../internal/deferred';
import { RpcPeer } from '../internal/rpc';
import type {
  FrameToHostMessage,
  HostToFrameMessage,
  SandboxInfo,
  SandboxLogLevel,
  SurfaceGeometry,
} from '../protocol';
import type {
  SandboxContract,
  SandboxHandle,
  SandboxLogEntry,
  SandboxRequestOptions,
  SandboxResizeOptions,
  SandboxState,
} from '../types';
import { FramePresenter } from './frames';
import type { NormalizedOptions, ResolvedSource } from './options';
import { assignSrcdoc } from './trusted-types';

const HIDDEN_FRAME_STYLE =
  'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
const VISIBLE_FRAME_STYLE =
  'position:relative;display:block;width:100%;height:360px;border:1px solid #333;';

const RESERVED_EVENT_PREFIX = 'mica:';
const FRAME_EVENT = 'mica:frame';
const SURFACE_EVENT = 'mica:surface';

export interface SandboxSessionInit {
  options: NormalizedOptions;
  runtime: string;
  source: ResolvedSource;
  /** Frame document for `srcdoc` mode; `undefined` when `frameUrl` is used. */
  frameDocument: string | undefined;
}

export class SandboxSession<
  G extends SandboxContract = SandboxContract,
> implements SandboxHandle<G> {
  readonly id: string;
  readonly name: string;
  readonly #init: SandboxSessionInit;
  readonly #presenter: FramePresenter;
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #frameReady: Deferred<void>;
  readonly #readyInfo: Deferred<SandboxInfo>;
  #iframe: HTMLIFrameElement | undefined;
  #peer: RpcPeer | undefined;
  #info: SandboxInfo | undefined;
  #state: SandboxState = 'ready';
  #termination: Promise<void> | undefined;
  #geometry: SurfaceGeometry;

  constructor(init: SandboxSessionInit) {
    this.#init = init;
    this.id = `mica-sandbox-${++sessionCounter}`;
    this.name = init.options.name;
    this.#geometry = measureCanvas(init.options.canvas);

    this.#presenter = new FramePresenter({
      canvas: init.options.canvas,
      maxFps: init.options.maxFps,
      onFrame: init.options.onFrame,
    });
    this.#presenter.setGeometry(this.#geometry);

    this.#frameReady = createDeferred<void>();
    this.#readyInfo = createDeferred<SandboxInfo>();
    // These are awaited in boot(); keep late rejections from surfacing as unhandled ones.
    void this.#frameReady.promise.catch(() => {});
    void this.#readyInfo.promise.catch(() => {});
  }

  get state(): SandboxState {
    return this.#state;
  }

  get info(): SandboxInfo {
    if (!this.#info) {
      throw new SandboxError('boot-failed', 'Sandbox info is only available after boot completes');
    }
    return this.#info;
  }

  get canvas(): HTMLCanvasElement | undefined {
    return this.#init.options.canvas;
  }

  async boot(): Promise<void> {
    const { options, frameDocument } = this.#init;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = `Mica sandbox: ${options.name}`;
    frame.style.cssText = options.hidden ? HIDDEN_FRAME_STYLE : VISIBLE_FRAME_STYLE;
    this.#iframe = frame;

    if (options.frameUrl !== undefined) {
      frame.src = options.frameUrl;
    } else {
      assignSrcdoc(frame, frameDocument ?? '', options.trustedTypesPolicy);
    }

    window.addEventListener('message', this.#onWindowMessage);
    (options.container ?? document.body).append(frame);

    try {
      await withTimeout(this.#frameReady.promise, options.bootTimeoutMs, () =>
        this.#bootTimeoutError(),
      );
      this.#sendBootMessage();
      this.#info = await withTimeout(this.#readyInfo.promise, options.bootTimeoutMs, () =>
        this.#bootTimeoutError(),
      );
    } catch (error) {
      await this.terminate('boot failed');
      throw error instanceof SandboxError
        ? error
        : new SandboxError('boot-failed', `Sandbox "${options.name}" failed to boot`, {
            cause: error,
          });
    }
  }

  call<M extends keyof G & string>(
    method: M,
    ...args: Parameters<G[M]>
  ): Promise<Awaited<ReturnType<G[M]>>> {
    return this.request(method, args) as Promise<Awaited<ReturnType<G[M]>>>;
  }

  request(
    method: string,
    args: readonly unknown[] = [],
    options: SandboxRequestOptions = {},
  ): Promise<unknown> {
    const peer = this.#peer;
    if (!peer || this.#state === 'terminated') {
      return Promise.reject(new SandboxError('terminated', `Sandbox "${this.name}" is terminated`));
    }

    const timeoutMs = options.timeoutMs ?? this.#init.options.callTimeoutMs;
    const requestOptions: { transfer?: readonly Transferable[]; timeoutMs?: number } = {
      timeoutMs,
    };
    if (options.transfer !== undefined) requestOptions.transfer = options.transfer;

    const promise = peer.request(method, args, requestOptions);

    if (this.#init.options.onCallTimeout === 'terminate' && timeoutMs > 0) {
      void promise.catch((error: unknown) => {
        if (error instanceof SandboxError && error.code === 'timeout') {
          void this.terminate('call timed out');
        }
      });
    }

    return promise;
  }

  notify(method: string, args: readonly unknown[] = [], transfer?: readonly Transferable[]): void {
    this.#peer?.notify(method, args, transfer);
  }

  emit(type: string, payload?: unknown, transfer?: readonly Transferable[]): void {
    assertPublicEventName(type);
    this.#peer?.emit(type, payload, transfer);
  }

  on(type: string, listener: (payload: unknown) => void): () => void {
    assertPublicEventName(type);
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => this.off(type, listener);
  }

  off(type: string, listener: (payload: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  resize(size: SandboxResizeOptions): void {
    const dpr = size.dpr ?? currentDevicePixelRatio();
    const geometry: SurfaceGeometry = {
      width: Math.max(1, Math.round(size.width * dpr)),
      height: Math.max(1, Math.round(size.height * dpr)),
      dpr,
    };
    this.#geometry = geometry;
    this.#presenter.setGeometry(geometry);
    this.#peer?.emit(SURFACE_EVENT, geometry);
  }

  terminate(reason = 'disposed'): Promise<void> {
    if (this.#termination) return this.#termination;

    const error = new SandboxError('terminated', `Sandbox "${this.name}" terminated: ${reason}`);
    this.#termination = Promise.resolve().then(() => {
      this.#state = 'terminated';
      this.#readyInfo.reject(error);
      this.#frameReady.reject(error);

      window.removeEventListener('message', this.#onWindowMessage);
      this.#presenter.dispose();

      const frame = this.#iframe;
      this.#iframe = undefined;
      const peer = this.#peer;
      this.#peer = undefined;

      if (peer) {
        // Graceful guest shutdown (abort signal + dispose) before the worker is destroyed.
        peer.emit('mica:terminate');
        peer.closePending(error);
      }

      if (!frame) {
        peer?.destroy(error);
        return;
      }

      try {
        frame.contentWindow?.postMessage(
          { type: 'mica:terminate' } satisfies HostToFrameMessage,
          '*',
        );
      } catch {
        // The frame is already gone.
      }
      // Let the terminate message flush before dropping the document.
      setTimeout(() => {
        frame.remove();
        peer?.destroy(error);
      }, 0);
    });

    return this.#termination;
  }

  #sendBootMessage(): void {
    const frame = this.#iframe;
    const port = new MessageChannel();

    this.#peer = new RpcPeer(port.port1, {
      onRequest: (method, args) => this.#invokeCapability(method, args),
      onEvent: (type, payload) => this.#handleGuestEvent(type, payload),
      onNotify: (method, args) => this.#invokeNotify(method, args),
      onLog: (level, parts) => this.#handleLog(level, parts),
      onGuestError: (guestError) => this.#dispatch('error', guestError),
      onReady: (info) => this.#readyInfo.resolve(info),
      onBootError: (bootError) => this.#readyInfo.reject(this.#asBootError(bootError)),
      onProtocolError: (protocolError) => this.#dispatch('error', protocolError),
    });

    const message: HostToFrameMessage = {
      type: 'mica:boot',
      id: this.id,
      name: this.name,
      runtime: this.#init.runtime,
      source: this.#init.source,
      surface: this.#geometry,
      captureConsole: this.#init.options.captureConsole,
      port: port.port2,
    };
    frame?.contentWindow?.postMessage(message, '*', [port.port2]);
  }

  async #invokeCapability(method: string, args: unknown[]): Promise<unknown> {
    const capability = this.#init.options.capabilities[method];
    if (!capability) {
      throw new SandboxError('capability-not-found', `Guest called unknown capability "${method}"`);
    }
    try {
      return await (capability as unknown as (...callArgs: unknown[]) => unknown)(...args);
    } catch (error) {
      throw new SandboxError(
        'capability-failed',
        `Capability "${method}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  #invokeNotify(method: string, args: unknown[]): void {
    void this.#invokeCapability(method, args).catch((error: unknown) =>
      this.#dispatch('error', error),
    );
  }

  #handleLog(level: SandboxLogLevel, parts: unknown[]): void {
    const entry: SandboxLogEntry = { level, parts, timestamp: Date.now() };
    this.#init.options.onLog?.(entry);
  }

  #handleGuestEvent(type: string, payload: unknown): void {
    if (type === FRAME_EVENT) {
      const frame = payload as { bitmap?: ImageBitmap; geometry?: SurfaceGeometry } | null;
      if (frame?.bitmap) {
        this.#presenter.present(frame.bitmap, frame.geometry ?? this.#geometry);
      }
      return;
    }
    if (type === SURFACE_EVENT || type.startsWith(RESERVED_EVENT_PREFIX)) return;
    this.#dispatch(type, payload);
  }

  #dispatch(type: string, payload: unknown): void {
    const listeners = this.#listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[@mica/sandbox] listener for "${type}" threw`, error);
      }
    }
  }

  #onWindowMessage = (event: MessageEvent): void => {
    const frame = this.#iframe;
    if (!frame || event.source !== frame.contentWindow) return;

    const data = event.data as FrameToHostMessage | null;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'mica:frame-ready') {
      this.#frameReady.resolve();
      return;
    }
    if (data.type === 'mica:frame-error') {
      const error = new SandboxError('frame-error', this.#describeFrameError(data.message));
      if (this.#info) this.#dispatch('error', error);
      else this.#readyInfo.reject(error);
    }
  };

  #asBootError(error: unknown): SandboxError {
    if (error instanceof SandboxError && error.code !== 'guest-error') return error;
    const cause = error instanceof Error ? error : undefined;
    const message = cause ? cause.message : String(error);
    return new SandboxError(
      'boot-failed',
      `Sandbox "${this.name}" failed to boot: ${message}`,
      cause ? { cause } : {},
    );
  }

  #describeFrameError(message: string): string {
    const lines = [`Sandbox frame reported: ${message}`];
    if (this.#init.options.frameUrl === undefined) {
      lines.push(
        'The srcdoc document inherits the page CSP. Allow inline scripts (or pass `nonce`), ' +
          'plus blob: in script-src and `worker-src blob:`.',
        'Using `frameUrl` avoids CSP inheritance entirely.',
      );
    }
    return lines.join('\n');
  }

  #bootTimeoutError(): SandboxError {
    const { options } = this.#init;
    const mode =
      options.frameUrl === undefined
        ? [
            'srcdoc documents inherit the page CSP, so the host must allow:',
            "  script-src 'unsafe-inline' (or a nonce passed via `nonce`) blob: 'unsafe-eval';",
            '  worker-src blob:;',
            'Apps with a strict CSP should use the `frameUrl` mode instead.',
          ]
        : [
            `Make sure "${options.frameUrl}" is reachable and allowed by frame-src,`,
            'and that the frame document keeps worker-src blob: in its own CSP.',
          ];
    return new SandboxError(
      'boot-timeout',
      [
        `Sandbox "${options.name}" did not become ready within ${options.bootTimeoutMs}ms.`,
        ...mode,
      ].join('\n'),
    );
  }
}

let sessionCounter = 0;

function assertPublicEventName(type: string): void {
  if (typeof type !== 'string' || type === '') {
    throw new SandboxError('invalid-options', 'Event names must be non-empty strings');
  }
  if (type.startsWith(RESERVED_EVENT_PREFIX)) {
    throw new SandboxError(
      'invalid-options',
      `Event names starting with "${RESERVED_EVENT_PREFIX}" are reserved`,
    );
  }
}

function currentDevicePixelRatio(): number {
  return typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

function measureCanvas(canvas: HTMLCanvasElement | undefined): SurfaceGeometry {
  const dpr = currentDevicePixelRatio();
  if (!canvas) return { width: 300, height: 150, dpr };
  return {
    width: canvas.width > 0 ? canvas.width : 300,
    height: canvas.height > 0 ? canvas.height : 150,
    dpr,
  };
}
