/**
 * Minimal Trusted Types policy shape. Declared locally because the DOM lib does not ship the
 * Trusted Types types in every TypeScript release.
 */
export interface TrustedHtmlPolicy {
  createHTML(input: string): unknown;
}

export interface SandboxWorkerOptions {
  /** Diagnostic name used by the frame document and error reporting. */
  name?: string;
  /** Element that hosts the offscreen iframe. Defaults to `document.body`. */
  container?: HTMLElement;
  /** Handshake budget. Defaults to 10s. */
  bootTimeoutMs?: number;
  /** Serve the frame document from this URL instead of using `srcdoc`. */
  frameUrl?: string;
  /** Nonce to reuse from the host CSP in `srcdoc` mode. */
  nonce?: string;
  /** Pre-created Trusted Types policy used for `srcdoc` assignment. */
  trustedTypesPolicy?: TrustedHtmlPolicy;
  /** Overrides the frame document policy (srcdoc mode only). */
  csp?: string | ((defaultCsp: string) => string);
}

export type SandboxState = 'ready' | 'terminated';

/** Uncaught worker failure, forwarded from the frame's `worker.onerror` listener. */
export interface SandboxWorkerError {
  readonly message: string;
  readonly filename: string | undefined;
  readonly lineno: number | undefined;
  readonly colno: number | undefined;
}

export type SandboxPostMessageOptions = readonly Transferable[] | StructuredSerializeOptions;

export interface SandboxWorker {
  readonly id: string;
  readonly name: string;
  readonly state: SandboxState;
  /** Resolves after the iframe has created the real Worker. */
  readonly ready: Promise<void>;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, options?: SandboxPostMessageOptions): void;
  addEventListener(
    type: 'message',
    listener: ((event: MessageEvent) => void) | EventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: 'messageerror',
    listener: ((event: MessageEvent) => void) | EventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: 'error',
    listener: ((event: ErrorEvent) => void) | EventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: 'message',
    listener: ((event: MessageEvent) => void) | EventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: 'messageerror',
    listener: ((event: MessageEvent) => void) | EventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: 'error',
    listener: ((event: ErrorEvent) => void) | EventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  /** Subscribes to uncaught worker failures; returns an unsubscribe function. */
  onError(listener: (error: SandboxWorkerError) => void): () => void;
  terminate(reason?: string): Promise<void>;
}
