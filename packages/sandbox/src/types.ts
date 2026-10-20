import type { SandboxInfo, SandboxLogLevel, SurfaceGeometry } from './protocol';

/**
 * Host-provided function. Capabilities accept anything the caller passes; validate inside.
 * `never[]` parameters keep specific object shapes assignable to the generic contract.
 */
export type SandboxCapability = (...args: never[]) => unknown;

/** Methods the guest exposes to the host, keyed by method name. */
export type SandboxCapabilities = Record<string, SandboxCapability>;

/** Loosely typed contract used when the caller does not declare the guest API. */
export interface SandboxContract {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [method: string]: (...args: any[]) => unknown;
}

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

export type SandboxState = 'ready' | 'terminated';

export interface SandboxLogEntry {
  level: SandboxLogLevel;
  parts: unknown[];
  timestamp: number;
}

export interface SandboxRequestOptions {
  transfer?: readonly Transferable[];
  timeoutMs?: number;
}

export interface SandboxResizeOptions {
  width: number;
  height: number;
  dpr?: number;
}

export interface SandboxHostOptions {
  source: SandboxSource;
  /** Functions the guest may call through `ctx.invoke(name, ...)`. */
  capabilities?: SandboxCapabilities;
  /** Diagnostic name, also reported back by the guest. */
  name?: string;
  /** Element that hosts the hidden iframe. Defaults to `document.body`. */
  container?: HTMLElement;
  /** Keep the iframe visible for debugging. Defaults to `false`. */
  hidden?: boolean;
  /** Handshake budget. Defaults to 10s. */
  bootTimeoutMs?: number;
  /** Default budget for `call`/`request`. `0` disables the timeout. */
  callTimeoutMs?: number;
  /** What to do when a call times out. Defaults to `reject`. */
  onCallTimeout?: 'reject' | 'terminate';
  /**
   * Serve the frame document from this URL instead of using `srcdoc`. Required for apps with a
   * strict CSP, because `srcdoc` documents inherit the embedder policy.
   */
  frameUrl?: string;
  /** Nonce to reuse from the host CSP in `srcdoc` mode. Auto-detected when omitted. */
  nonce?: string;
  /** Pre-created Trusted Types policy used for `srcdoc` assignment. */
  trustedTypesPolicy?: TrustedHtmlPolicy;
  /** Overrides the frame document policy (srcdoc mode only). */
  csp?: string | ((defaultCsp: string) => string);
  /** Host canvas that guest frames are composited into. */
  canvas?: HTMLCanvasElement;
  /** Receives guest frames when no canvas is given. */
  onFrame?: (bitmap: ImageBitmap, geometry: SurfaceGeometry) => void;
  /** Upper bound for composited frames per second. `0` disables throttling. Defaults to 60. */
  maxFps?: number;
  /** Overrides the inlined guest runtime (advanced/testing). */
  runtime?: string;
  /** Forward `console.*` from the guest. Defaults to `true`. */
  captureConsole?: boolean;
  onLog?: (entry: SandboxLogEntry) => void;
}

export interface SandboxHandle<G extends SandboxContract = SandboxContract> {
  readonly id: string;
  readonly name: string;
  readonly state: SandboxState;
  readonly info: SandboxInfo;
  /** Canvas the sandbox composites guest frames into, when one was provided. */
  readonly canvas: HTMLCanvasElement | undefined;
  call<M extends keyof G & string>(
    method: M,
    ...args: Parameters<G[M]>
  ): Promise<Awaited<ReturnType<G[M]>>>;
  request(
    method: string,
    args?: readonly unknown[],
    options?: SandboxRequestOptions,
  ): Promise<unknown>;
  notify(method: string, args?: readonly unknown[], transfer?: readonly Transferable[]): void;
  emit(type: string, payload?: unknown, transfer?: readonly Transferable[]): void;
  on(type: string, listener: (payload: unknown) => void): () => void;
  off(type: string, listener: (payload: unknown) => void): void;
  resize(size: SandboxResizeOptions): void;
  terminate(reason?: string): Promise<void>;
}

export type GuestHandler = (...args: never[]) => unknown;

export interface GuestMethods {
  [name: string]: GuestHandler;
}

export interface GuestSurfaceOptions {
  width?: number;
  height?: number;
  dpr?: number;
}

/** An `OffscreenCanvas` inside the guest that can be published to the host frame by frame. */
export interface GuestSurface {
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** Transfers the current frame to the host. Resets the canvas to transparent. */
  commit(): void;
  resize(width: number, height: number, dpr?: number): void;
}

export interface GuestContext {
  readonly id: string;
  readonly name: string;
  /** Aborted when the sandbox is terminated. */
  readonly signal: AbortSignal;
  /** Exposes a method the host can reach with `sandbox.call()`. */
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
  createSurface(options?: GuestSurfaceOptions): GuestSurface;
}

export type GuestSetupResult =
  void | GuestMethods | (() => void) | Promise<void | GuestMethods | (() => void)>;
