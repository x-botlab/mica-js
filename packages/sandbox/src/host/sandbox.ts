import { SandboxError } from '../errors';
import { createDeferred, withTimeout } from '../internal/deferred';
import type { Deferred } from '../internal/deferred';
import type { FrameToHostMessage, HostToFrameMessage } from '../protocol';
import type {
  SandboxSource,
  SandboxState,
  SandboxWorker as SandboxWorkerApi,
  SandboxWorkerOptions,
} from '../types';
import type { NormalizedOptions, ResolvedSource } from './options';
import { assertBrowserEnvironment, normalizeOptions, resolveSource } from './options';
import { applyCspOverride, buildFrameCsp, generateNonce } from './csp';
import { buildFrameDocument } from './frame-document';
import { assignSrcdoc, detectNonce } from './trusted-types';

export class SandboxWorker implements SandboxWorkerApi {
  readonly id: string;
  readonly name: string;
  readonly ready: Promise<MessagePort>;
  readonly #options: NormalizedOptions;
  readonly #frameReady: Deferred<void>;
  readonly #readyPort: Deferred<MessagePort>;
  #runtime = '';
  #source: ResolvedSource | undefined;
  #frameDocument: string | undefined;
  #iframe: HTMLIFrameElement | undefined;
  #port: MessagePort | undefined;
  #state: SandboxState = 'ready';
  #termination: Promise<void> | undefined;

  constructor(source: SandboxSource, options: SandboxWorkerOptions = {}) {
    assertBrowserEnvironment();
    this.#options = normalizeOptions(source, options);
    this.id = `mica-sandbox-${this.#options.name}`;
    this.name = this.#options.name;
    this.#frameReady = createDeferred<void>();
    this.#readyPort = createDeferred<MessagePort>();
    this.ready = this.#readyPort.promise;
    void this.#boot(source).catch((error) => this.#readyPort.reject(error));
  }

  get state(): SandboxState {
    return this.#state;
  }

  async #boot(source: SandboxSource): Promise<void> {
    const options = this.#options;
    this.#source = await resolveSource(source);
    this.#runtime =
      options.runtime ?? (await import('../internal/runtime-source')).GUEST_RUNTIME_SOURCE;
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
      this.#sendBootMessage();
      await withTimeout(this.#readyPort.promise, options.bootTimeoutMs, () =>
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

  terminate(reason = 'disposed'): Promise<void> {
    if (this.#termination) return this.#termination;
    const error = new SandboxError('terminated', `Sandbox "${this.name}" terminated: ${reason}`);
    this.#termination = Promise.resolve().then(() => {
      this.#state = 'terminated';
      this.#readyPort.reject(error);
      this.#frameReady.reject(error);
      window.removeEventListener('message', this.#onWindowMessage);
      const frame = this.#iframe;
      this.#iframe = undefined;
      try {
        frame?.contentWindow?.postMessage(
          { type: 'mica:terminate' } satisfies HostToFrameMessage,
          '*',
        );
      } catch {
        // The frame is already gone.
      }
      this.#port?.close();
      this.#port = undefined;
      frame?.remove();
    });
    return this.#termination;
  }

  #sendBootMessage(): void {
    const frame = this.#iframe;
    const channel = new MessageChannel();
    this.#port = channel.port1;
    const message: HostToFrameMessage = {
      type: 'mica:boot',
      id: this.id,
      name: this.name,
      runtime: this.#runtime,
      source: this.#source!,
      captureConsole: this.#options.captureConsole,
      port: channel.port2,
    };
    frame?.contentWindow?.postMessage(message, '*', [channel.port2]);
  }

  #onWindowMessage = (event: MessageEvent): void => {
    const frame = this.#iframe;
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as FrameToHostMessage | null;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'mica:frame-ready') this.#frameReady.resolve();
    else if (data.type === 'mica:worker-ready' && this.#port) this.#readyPort.resolve(this.#port);
    else if (data.type === 'mica:frame-error') {
      this.#readyPort.reject(new SandboxError('boot-failed', data.message));
    }
  };

  #bootTimeoutError(): SandboxError {
    return new SandboxError('boot-timeout', `Sandbox "${this.name}" did not become ready in time`);
  }
}
