/**
 * Minimal Trusted Types policy shape. Declared locally because the DOM lib does not ship the
 * Trusted Types types in every TypeScript release.
 */
export interface TrustedHtmlPolicy {
  createHTML(input: string): unknown;
}

export interface ModuleSourceFromCode {
  type: 'module';
  code: string;
}

export interface ModuleSourceFromUrl {
  type: 'module';
  url: string;
}

export interface ScriptSourceFromCode {
  type: 'script';
  code: string;
  /** Global the classic script assigns its entry point to. Defaults to `MicaGuest`. */
  globalName?: string;
}

export interface ScriptSourceFromUrl {
  type: 'script';
  url: string;
  globalName?: string;
}

/**
 * Guest program. `module` sources are ESM loaded with `import()`, `script` sources are classic
 * scripts loaded with `importScripts()`. URL sources are fetched by the host and inlined, because
 * the guest runs in an opaque origin without network access.
 */
export type SandboxSource =
  ModuleSourceFromCode | ModuleSourceFromUrl | ScriptSourceFromCode | ScriptSourceFromUrl;

export interface SandboxWorkerOptions {
  /** Diagnostic name used by the frame and guest runtime. */
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
  /** Overrides the inlined guest runtime (advanced/testing). */
  runtime?: string;
  /** Forward guest console output through the host-control RPC service. */
  captureConsole?: boolean;
}

export type SandboxState = 'ready' | 'terminated';

export interface SandboxWorker {
  readonly id: string;
  readonly name: string;
  readonly state: SandboxState;
  readonly ready: Promise<MessagePort>;
  terminate(reason?: string): Promise<void>;
}

export type GuestHandler = (...args: never[]) => unknown;

export interface GuestMethods {
  [name: string]: GuestHandler;
}

export interface SandboxRequestOptions {
  transfer?: readonly Transferable[];
  timeoutMs?: number;
}

export interface GuestContext {
  readonly id: string;
  readonly name: string;
  /** Aborted when the sandbox is terminated. */
  readonly signal: AbortSignal;
  /** Exposes a method the host can reach through the RPC service. */
  handle(name: string, handler: GuestHandler): void;
  /** Calls a host capability. */
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
  invokeWith(
    name: string,
    args: readonly unknown[],
    options?: SandboxRequestOptions,
  ): Promise<unknown>;
  on(type: string, listener: (payload: unknown) => void): () => void;
  off(type: string, listener: (payload: unknown) => void): void;
  emit(type: string, payload?: unknown, transfer?: readonly Transferable[]): void;
  log(...parts: unknown[]): void;
}

export type GuestSetupResult =
  void | GuestMethods | (() => void) | Promise<void | GuestMethods | (() => void)>;
