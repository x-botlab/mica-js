/**
 * Bootstrap of one device HTML view environment (RFC 0023), bundled as `environment.js`.
 *
 * The editor loads this module from the deployment directory behind `viewBaseUrlTemplate` in an
 * iframe of its own origin. It accepts exactly one handshake from the embedding editor and keeps the
 * control lane of the view: the theme relay, the loading lifecycle and the failure report. The
 * author lane and the package lane do not belong to this page — the editor creates both ports on
 * request and this page only transfers them, one into the package worker and one into the permanent
 * INNER sandbox frame created from the real `content.html` document of the same deployment
 * directory. This trusted page never rewrites itself; it writes the author document into the inner
 * document once that frame announced its API and its package grant, so a navigation of the author
 * document is a fault instead of a silent reload.
 */
import { createRpc } from '@mica-js/core/rpc';
import type { RpcProxy } from '@mica-js/core/rpc';
import { messageOf } from '../../runtime/wire';
import {
  ENVIRONMENT_CONTENT_DOCUMENT_FILE,
  ENVIRONMENT_WORKER_FILE,
  HTML_VIEW_CONTENT_POLICY,
  authorBaseUrl,
  concreteOriginOf,
  decodeDocument,
  withHtmlDocumentPreamble,
} from '../paths';
import {
  HTML_VIEW_ACK,
  HTML_VIEW_ASSETS,
  HTML_VIEW_ASSETS_ACK,
  HTML_VIEW_CHILD_CONNECT,
  HTML_VIEW_CHILD_HELLO,
  HTML_VIEW_CHILD_PREPARED,
  HTML_VIEW_CONNECT,
  HTML_VIEW_FRAME_PARAM,
  fusedHtmlHostControlService,
} from '../protocol';
import type {
  IFusedHtmlHostControlService,
  IHtmlViewAssetAckMessage,
  IHtmlViewAssetGrantMessage,
  IHtmlViewChildConnectMessage,
  IHtmlViewChildHelloMessage,
  IHtmlViewChildPreparedMessage,
  IHtmlViewConnectMessage,
  IHtmlViewTheme,
} from '../protocol';
import {
  DEFAULT_HTML_VIEW_THEME,
  applyHtmlViewTheme,
  htmlViewBackgroundColor,
  htmlViewThemeCss,
  normalizeHtmlViewTheme,
} from '../theme';

/** Timing seams of the bootstrap; production uses the defaults. */
export interface IHtmlViewEnvironmentOptions {
  readonly window?: Window;
  readonly document?: Document;
  /** Budget of the editor handshake; defaults to 15 s. */
  readonly handshakeTimeoutMs?: number;
  /** Budget of the asset worker activation and grant; defaults to 10 s. */
  readonly workerTimeoutMs?: number;
  /** Budget until the inner frame asks for its bridge; defaults to 15 s. */
  readonly contentTimeoutMs?: number;
  /**
   * Absolute URL of the inner content document.
   *
   * Defaults to `content.html` next to this module; a host may serve it under another path of the
   * same environment origin, never another origin.
   */
  readonly contentUrl?: string;
}

interface IHtmlViewHandshake {
  readonly message: IHtmlViewConnectMessage;
  readonly port: MessagePort;
}

/** Latest theme of the workbench and the inner frame that must mirror it. */
interface IThemeRelay {
  readonly current: IHtmlViewTheme;
  /** Reads the first snapshot without losing a change that lands during the read. */
  load(): Promise<void>;
  /** Mirrors the latest theme onto the document of one inner frame, in place. */
  track(frame: HTMLIFrameElement): void;
}

/**
 * Starts the environment of one view.
 *
 * @throws when the editor never hands over a bridge port or the package resources cannot be served;
 * the editor reports the view as failed after its own handshake budget.
 */
export async function startHtmlViewEnvironment(
  options: IHtmlViewEnvironmentOptions = {},
): Promise<void> {
  const win = options.window ?? globalThis.window;
  const doc = options.document ?? win.document;
  const handshake = await waitForHandshake(win, options.handshakeTimeoutMs ?? 15_000);
  const { message, port } = handshake;
  // The handshake carries the editor origin, so the answer is never posted to a wildcard target.
  win.parent.postMessage({ type: HTML_VIEW_ACK, token: message.token }, message.parentOrigin);

  const endpoint = createRpc(port);
  const control = endpoint.getProxy(fusedHtmlHostControlService);
  const report = (code: string, text: string): void => {
    void control.reportFailure(code, text).catch(() => undefined);
  };
  const theme = watchTheme(control, report, doc);
  try {
    await theme.load();
    await connectAssetWorker(win, message, control, options.workerTimeoutMs ?? 10_000);
    // The outer frame composes the author document itself, so it is the one reader of the entry.
    const bytes = await control.readAsset(message.target.entry);
    const authored = decodeDocument(bytes);
    mountContent({
      window: win,
      document: doc,
      control,
      message,
      authored,
      theme,
      contentUrl:
        options.contentUrl ?? new URL(ENVIRONMENT_CONTENT_DOCUMENT_FILE, import.meta.url).href,
      budgetMs: options.contentTimeoutMs ?? 15_000,
      report,
    });
    win.addEventListener('pagehide', () => {
      try {
        control.closed();
      } catch {
        // The port is already gone when the page is torn down.
      }
    });
  } catch (cause) {
    report('view/load-failed', messageOf(cause));
    throw cause;
  }
}

interface IContentMountOptions {
  readonly window: Window;
  readonly document: Document;
  readonly control: RpcProxy<IFusedHtmlHostControlService>;
  readonly message: IHtmlViewConnectMessage;
  /** Author document as it came out of the verified package. */
  readonly authored: string;
  readonly theme: IThemeRelay;
  readonly contentUrl: string;
  readonly budgetMs: number;
  readonly report: (code: string, message: string) => void;
}

/**
 * Creates the inner sandbox frame and hands the author port on.
 *
 * The frame is a real `content.html` document of this deployment directory, so both frames share one
 * concrete origin. The port belongs to the editor lease and this page only transfers it once the
 * frame announced its own token, so no author call passes through here. The author document is
 * written by this page into `frame.contentDocument` once the inner bootstrap announced that the API
 * and the package grant are in place; a second start of the bootstrap or a frame that leaves its
 * content URL is an explicit failure.
 */
function mountContent(options: IContentMountOptions): void {
  const { window: win, document: doc, control, message, authored, theme, report } = options;
  const target = message.target;
  const origin = concreteOriginOf(win.location.href);
  if (origin === undefined) throw new Error('The environment page has no concrete origin.');
  const token = createToken();
  const contentUrl = new URL(options.contentUrl);
  if (concreteOriginOf(contentUrl.href) !== origin)
    throw new Error('The content document must be served from the environment origin.');
  contentUrl.searchParams.set(HTML_VIEW_FRAME_PARAM, token);
  const frame = doc.createElement('iframe');
  frame.className = 'mica-html-view-document';
  frame.title = `${target.title} — ${target.device}`;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  frame.style.display = 'block';
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.border = '0';
  // Painted before the frame is appended, so the inner bootstrap document never shows the white
  // canvas of a fresh browsing context.
  frame.style.background = htmlViewBackgroundColor(theme.current);
  // Tracked before the document exists, so a theme change while the bootstrap is still loading
  // repaints this element instead of leaving the first color behind.
  theme.track(frame);

  let bridged = false;
  let bridging = false;
  let written = false;
  let failing = false;
  /**
   * Document this frame loaded from its content URL.
   *
   * Its identity, not its URL, proves the frame never navigated: `document.open()` keeps the same
   * document but repoints its URL at this environment page, while any navigation installs a new one.
   */
  let contentDocument: Document | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (text: string): void => {
    if (failing) return;
    failing = true;
    clearTimer();
    report('view/execution-failed', text);
  };
  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const onHello = (event: MessageEvent): void => {
    const data = event.data as Partial<IHtmlViewChildHelloMessage> | null;
    if (data === null || typeof data !== 'object' || data.type !== HTML_VIEW_CHILD_HELLO) return;
    if (data.token !== token) return;
    // Both frames are real documents of one origin, so the source and the origin are exact.
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== origin) return;
    if (failing) return;
    if (bridged || bridging) {
      // Only one bootstrap may own the content frame: a second start is a reload of its document.
      fail('The HTML view document started twice.');
      return;
    }
    // The author lane belongs to the editor lease, so this page asks for its port and hands it on
    // without ever reading through it.
    bridging = true;
    clearTimer();
    void control.contentPort().then(
      (port) => {
        if (bridged || failing) {
          port.close();
          return;
        }
        const targetWindow = frame.contentWindow;
        if (targetWindow === null) {
          port.close();
          fail('The HTML view document frame is not available.');
          return;
        }
        // The author document has not been written yet, so the frame must still run its content URL:
        // a frame that reloaded or navigated in the meantime is never granted the author port.
        if (!isContentLocation(frame, contentUrl.href)) {
          port.close();
          fail('The HTML view navigated away from its author document.');
          return;
        }
        bridging = false;
        bridged = true;
        const connect: IHtmlViewChildConnectMessage = { type: HTML_VIEW_CHILD_CONNECT, token };
        try {
          targetWindow.postMessage(connect, origin, [port]);
        } catch (cause) {
          fail(`The HTML view bridge port was rejected: ${messageOf(cause)}`);
        }
      },
      (cause: unknown) => {
        if (bridged || failing) return;
        fail(`The HTML view bridge port was not granted: ${messageOf(cause)}`);
      },
    );
  };

  /**
   * Writes the author document once the inner frame announced its API and its package grant.
   *
   * The announcement is a plain control message, because the author lane is the editor's; the write
   * stays here, where the document, its policy and its theme live, and a refused write is a fault of
   * the view instead of an author page that never appears.
   */
  const onPrepared = (event: MessageEvent): void => {
    const data = event.data as Partial<IHtmlViewChildPreparedMessage> | null;
    if (data === null || typeof data !== 'object' || data.type !== HTML_VIEW_CHILD_PREPARED) return;
    if (data.token !== token) return;
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== origin) return;
    // Only the frame that owns the author port of this view may announce its readiness.
    if (!bridged || failing) return;
    try {
      writeAuthorDocument();
    } catch (cause) {
      fail(messageOf(cause));
      return;
    }
    void control.ready().catch((cause: unknown) => {
      fail(`The HTML view was not reported ready: ${messageOf(cause)}`);
    });
  };

  /**
   * Writes the author document into the inner document of this environment.
   *
   * The inner bootstrap already installed `acquireDeviceViewApi`, its listeners and its package
   * grant, so the author scripts see a complete bridge. `document.open()` replaces the document
   * contents but keeps the window, its listeners and the frame identity.
   */
  function writeAuthorDocument(): void {
    // One author document per frame: a second write would discard the running author page.
    if (written) throw new Error('The author document was already written.');
    const authorDocument = documentOf(frame);
    if (authorDocument === null) {
      throw new Error('The HTML view document frame is not available.');
    }
    if (contentDocument !== undefined && authorDocument !== contentDocument) {
      throw new Error('The HTML view document changed before its author document was written.');
    }
    // The identity is kept: the write reuses this document and only repoints its URL.
    contentDocument = authorDocument;
    authorDocument.open();
    // `document.open()` clears every listener of the window, so the author error lane is installed
    // between the open and the write: the first author script is already covered, and no author
    // error is lost to the document replacement.
    watchAuthorErrors(contentWindowOf(frame), report);
    authorDocument.write(
      withHtmlDocumentPreamble(authored, {
        base: authorBaseUrl(new URL(target.assetRoot), target.entry),
        policy: HTML_VIEW_CONTENT_POLICY,
        style: htmlViewThemeCss(theme.current),
      }),
    );
    authorDocument.close();
    written = true;
    // The write replaced the root element; mirror the current theme onto the new one in place.
    theme.track(frame);
  }

  frame.addEventListener('load', () => {
    // A navigation to another origin leaves no readable document at all.
    const current = documentOf(frame);
    if (current === null) {
      fail('The HTML view navigated away from its author document.');
      return;
    }
    if (contentDocument === undefined) {
      // The first load must be the content document itself; its URL is authoritative only here,
      // because the write of the author document repoints that URL at this environment page.
      if (!isContentLocation(frame, contentUrl.href)) {
        fail('The HTML view navigated away from its author document.');
        return;
      }
      contentDocument = current;
      theme.track(frame);
      return;
    }
    // Same document: the shell load, its own write, or a reload of the same document. A navigation
    // always replaces the document, and is reported exactly once.
    if (current !== contentDocument) {
      fail('The HTML view navigated away from its author document.');
      return;
    }
    theme.track(frame);
  });

  win.addEventListener('message', onHello);
  win.addEventListener('message', onPrepared);
  const parent = doc.body ?? doc.documentElement;
  frame.src = contentUrl.href;
  parent.append(frame);
  if (options.budgetMs > 0) {
    timer = setTimeout(() => {
      timer = undefined;
      fail('The HTML view document did not start in time.');
    }, options.budgetMs);
  }
}

/**
 * Reads the first theme without losing a change that lands while the snapshot is in flight.
 *
 * The subscription exists before the read, so `announced` tells a late snapshot from the newest
 * value: a change that arrived earlier always wins, and a view never starts with a stale theme.
 */
function watchTheme(
  control: RpcProxy<IFusedHtmlHostControlService>,
  report: (code: string, message: string) => void,
  ownDocument: Document,
): IThemeRelay {
  let theme: IHtmlViewTheme = DEFAULT_HTML_VIEW_THEME;
  let announced = 0;
  let target: HTMLIFrameElement | undefined;
  const apply = (): void => {
    // This trusted page shows the same view background while it loads and while it is not attached,
    // so a theme change during a delayed load never leaves a stale surface behind.
    try {
      applyHtmlViewTheme(ownDocument.documentElement, theme);
    } catch {
      // The trusted document is gone; the editor tears the environment down.
    }
    if (target === undefined) return;
    try {
      target.style.background = htmlViewBackgroundColor(theme);
    } catch {
      // A removed frame needs no paint.
    }
    const root = rootOf(target);
    if (root === null) return;
    try {
      applyHtmlViewTheme(root, theme);
    } catch {
      // A torn down document is a navigation the frame listener reports; the theme has no vote.
    }
  };
  control.onDidThemeChange((next) => {
    announced += 1;
    theme = acceptTheme(next, theme, report);
    apply();
  });
  return {
    get current() {
      return theme;
    },
    async load() {
      let snapshot: unknown;
      try {
        snapshot = await control.getTheme();
      } catch (cause) {
        report('view/bridge-failed', `The workbench theme is unavailable: ${messageOf(cause)}`);
        return;
      }
      if (announced > 0) return;
      theme = acceptTheme(snapshot, theme, report);
      // The trusted page paints the view background as soon as the first snapshot is known; the
      // inline bootstrap already covered the time before that answer.
      apply();
    },
    track(frame) {
      target = frame;
      apply();
    },
  };
}

function acceptTheme(
  value: unknown,
  fallback: IHtmlViewTheme,
  report: (code: string, message: string) => void,
): IHtmlViewTheme {
  try {
    return normalizeHtmlViewTheme(value);
  } catch (cause) {
    report('view/bridge-failed', `The workbench sent an unusable theme: ${messageOf(cause)}`);
    return fallback;
  }
}

/**
 * Reports author failures of the inner document.
 *
 * Installed by the environment right after it opened the inner document, because that open clears
 * the listeners of the window; the model and lifecycle subscriptions live on the bridge and are
 * unaffected by it.
 */
function watchAuthorErrors(
  contentWindow: Window | null,
  report: (code: string, message: string) => void,
): void {
  if (contentWindow === null) return;
  contentWindow.addEventListener('error', (event) => {
    report('view/execution-failed', event.message);
  });
  contentWindow.addEventListener('unhandledrejection', (event) => {
    report('view/execution-failed', messageOf(event.reason));
  });
}

/** Window of the inner frame, or `null` while it is not reachable. */
function contentWindowOf(frame: HTMLIFrameElement): Window | null {
  try {
    return frame.contentWindow;
  } catch {
    return null;
  }
}

/** Root element of the inner document, or `null` while the frame has no usable document. */
function rootOf(frame: HTMLIFrameElement): HTMLElement | null {
  try {
    return frame.contentDocument?.documentElement ?? null;
  } catch {
    return null;
  }
}

/** The document the environment writes into; a same-origin child is always readable. */
function documentOf(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument ?? null;
  } catch {
    return null;
  }
}

/** Whether the inner frame still runs the content document the environment loaded. */
function isContentLocation(frame: HTMLIFrameElement, expected: string): boolean {
  try {
    const target = frame.contentWindow;
    if (target === null) return false;
    return new URL(target.location.href).href === new URL(expected).href;
  } catch {
    // A cross-origin document is never the content document.
    return false;
  }
}

function waitForHandshake(win: Window, timeoutMs: number): Promise<IHtmlViewHandshake> {
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            win.removeEventListener('message', onMessage);
            reject(new Error('The editor did not hand over a bridge port.'));
          }, timeoutMs)
        : undefined;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as Partial<IHtmlViewConnectMessage> | null;
      if (data === null || typeof data !== 'object' || data.type !== HTML_VIEW_CONNECT) return;
      // Only the embedding page may grant the bridge, and only through this one-time token.
      if (event.source !== win.parent) return;
      if (typeof data.token !== 'string' || data.token.length === 0) return;
      // Only a concrete HTTP(S) editor origin may answer the handshake.
      if (typeof data.parentOrigin !== 'string' || !/^https?:\/\/[^/]+$/.test(data.parentOrigin))
        return;
      const target = data.target;
      if (target === null || typeof target !== 'object' || typeof target.entry !== 'string') return;
      if (typeof target.assetRoot !== 'string') return;
      let assetOrigin: string;
      try {
        assetOrigin = new URL(target.assetRoot).origin;
      } catch {
        return;
      }
      // The asset root is this environment's own package mirror, never another origin.
      if (assetOrigin !== win.location.origin) return;
      const port = event.ports[0];
      if (port === undefined) return;
      if (timer !== undefined) clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      resolve({ message: data as IHtmlViewConnectMessage, port });
    };
    win.addEventListener('message', onMessage);
  });
}

async function connectAssetWorker(
  win: Window,
  message: IHtmlViewConnectMessage,
  control: RpcProxy<IFusedHtmlHostControlService>,
  timeoutMs: number,
): Promise<void> {
  const root = new URL(message.target.assetRoot);
  const container = win.navigator;
  if (!('serviceWorker' in container) || container.serviceWorker === undefined) {
    throw new Error('This browser has no service worker support, so package files cannot load.');
  }
  const workers = container.serviceWorker;
  await workers.register(new URL(ENVIRONMENT_WORKER_FILE, import.meta.url), {
    type: 'module',
  });
  await waitForControl(workers, timeoutMs);
  const worker = workers.controller;
  if (worker === null) {
    throw new Error('The package asset worker did not activate.');
  }
  // The package lane belongs to the editor lease: the worker reads verified bytes there, and this
  // page only installs the grant and waits for its acknowledgement.
  const port = await control.assetPort();
  const reply = new MessageChannel();
  const acknowledged = waitForAssetAck(reply.port1, message.token, timeoutMs);
  const grant: IHtmlViewAssetGrantMessage = {
    type: HTML_VIEW_ASSETS,
    token: message.token,
    root: root.pathname,
  };
  worker.postMessage(grant, [port, reply.port2]);
  // The worker acknowledges the grant; the inner frame is created only once the grant is in place,
  // so the first package request of the author document is never a 404.
  await acknowledged;
}

/** Waits until the package worker owns the granted lane and confirms the grant. */
function waitForAssetAck(port: MessagePort, token: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            port.close();
            reject(new Error('The package asset worker did not answer its grant.'));
          }, timeoutMs)
        : undefined;
    port.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Partial<IHtmlViewAssetAckMessage> | null;
      if (data === null || typeof data !== 'object' || data.type !== HTML_VIEW_ASSETS_ACK) return;
      if (data.token !== token) return;
      if (timer !== undefined) clearTimeout(timer);
      port.close();
      resolve();
    });
    port.start();
  });
}

function waitForControl(workers: ServiceWorkerContainer, timeoutMs: number): Promise<void> {
  if (workers.controller !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      workers.removeEventListener('controllerchange', changed);
      resolve();
    };
    const changed = (): void => finish();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            workers.removeEventListener('controllerchange', changed);
            reject(new Error('The package asset worker did not take control of the view.'));
          }, timeoutMs)
        : undefined;
    workers.addEventListener('controllerchange', changed, { once: true });
    if (workers.controller !== null) finish();
  });
}

function createToken(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

if (typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined') {
  void startHtmlViewEnvironment().catch((cause: unknown) => {
    console.error('[@mica-js/editor] device view environment failed', cause);
  });
}
