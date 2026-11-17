import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcProxy } from '@mica-js/core/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKBENCH_DARK_COLORS, WORKBENCH_LIGHT_COLORS } from '../../theme';
import {
  HTML_VIEW_ASSETS,
  HTML_VIEW_ASSETS_ACK,
  HTML_VIEW_CHILD_CONNECT,
  HTML_VIEW_CHILD_HELLO,
  HTML_VIEW_CHILD_PREPARED,
  HTML_VIEW_CONNECT,
  HTML_VIEW_FRAME_PARAM,
  fusedHtmlAssetService,
  fusedHtmlContentViewService,
  fusedHtmlHostControlService,
  fusedHtmlHostService,
} from '../protocol';
import type {
  IFusedHtmlAssetService,
  IFusedHtmlContentViewService,
  IFusedHtmlHostControlService,
  IFusedHtmlHostService,
  IHtmlViewConnectMessage,
  IHtmlViewTarget,
  IHtmlViewTheme,
} from '../protocol';
import { transferBytes } from '../../runtime/wire';
import { startHtmlViewEnvironment } from './entry';

const ENVIRONMENT_ORIGIN = 'https://mica-1.example.com';
const ENVIRONMENT_URL = `${ENVIRONMENT_ORIGIN}/p/__mica_view__/index.html`;
const ASSET_ROOT = `${ENVIRONMENT_ORIGIN}/p/__mica_view__/__mica_package__/`;
const EDITOR_ORIGIN = 'https://editor.example.com';
const TOKEN = 'f'.repeat(32);
const AUTHOR_HTML =
  '<!doctype html><html><head><title>Serial</title></head><body><p>monitor</p></body></html>';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- fake DOM

class FakeStyle {
  readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }
}

class FakeDocumentRoot {
  readonly style = new FakeStyle();
}

class FakeContentDocument {
  documentElement = new FakeDocumentRoot();
  readonly operations: string[] = [];
  readonly writes: string[] = [];
  owner: FakeContentWindow | undefined;

  open(): void {
    // `document.open()` replaces the document contents, keeps the window and its bridge, and
    // clears every listener registered on that window.
    this.operations.push('open');
    this.documentElement = new FakeDocumentRoot();
    this.owner?.clearListeners();
  }

  write(html: string): void {
    this.operations.push('write');
    this.writes.push(html);
  }

  close(): void {
    this.operations.push('close');
  }
}

class FakeContentWindow {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly received: Array<{
    readonly message: unknown;
    readonly origin: string;
    readonly transfer: readonly Transferable[];
  }> = [];
  readonly document = new FakeContentDocument();
  readonly location: { href: string } = { href: '' };

  constructor(readonly parent: FakeOuterWindow) {
    this.document.owner = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let entries = this.listeners.get(type);
    if (entries === undefined) this.listeners.set(type, (entries = new Set()));
    entries.add(listener);
    this.document.operations.push(`listen:${type}`);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  deliver(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  postMessage(message: unknown, origin: string, transfer: readonly Transferable[] = []): void {
    this.received.push({ message, origin, transfer });
  }

  /** Posts a message of the inner frame to the trusted environment page. */
  postToParent(data: unknown, origin = ENVIRONMENT_ORIGIN): void {
    this.parent.dispatchMessage({ type: 'message', data, origin, source: this, ports: [] });
  }

  connectMessage(): { readonly token: string; readonly port: MessagePort } | undefined {
    const entry = this.received.find(
      (item) =>
        (item.message as { readonly type?: string } | null)?.type === HTML_VIEW_CHILD_CONNECT,
    );
    const port = entry?.transfer[0];
    if (entry === undefined || !(port instanceof MessagePort)) return undefined;
    return { token: (entry.message as { readonly token: string }).token, port };
  }
}

class FakeFrame {
  readonly tagName = 'iframe';
  className = '';
  title = '';
  readonly attributes: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Set<() => void>();
  contentWindow: FakeContentWindow;
  contentDocument: FakeContentDocument | null;
  removed = false;
  private source = '';

  constructor(private readonly owner: FakeOuterWindow) {
    this.contentWindow = new FakeContentWindow(owner);
    this.contentDocument = this.contentWindow.document;
  }

  /** Simulates a navigation: a fresh window and document, or an unreadable cross-origin one. */
  navigate(url: string, options: { readonly crossOrigin?: boolean } = {}): void {
    this.contentWindow = new FakeContentWindow(this.owner);
    this.contentWindow.location.href = url;
    this.source = url;
    this.contentDocument = options.crossOrigin === true ? null : this.contentWindow.document;
  }

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    this.contentWindow.location.href = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'load') this.listeners.add(listener);
  }

  dispatch(type: string): void {
    if (type === 'load') for (const listener of [...this.listeners]) listener();
  }

  remove(): void {
    this.removed = true;
  }
}

class FakeBody {
  readonly children: FakeFrame[] = [];
  /** Background of every appended frame at the moment it was appended. */
  readonly appendedBackgrounds: string[] = [];
  append(...children: FakeFrame[]): void {
    for (const child of children) this.appendedBackgrounds.push(child.style['background'] ?? '');
    this.children.push(...children);
  }
}

class FakeOuterDocument {
  readonly body = new FakeBody();
  readonly documentElement = { append: () => undefined, style: new FakeStyle() };
  readonly open = vi.fn();
  readonly write = vi.fn();
  readonly close = vi.fn();

  constructor(private readonly owner: FakeOuterWindow) {}

  createElement(): FakeFrame {
    return new FakeFrame(this.owner);
  }
}

class FakeWorker {
  readonly posted: Array<{ readonly message: unknown; readonly ports: readonly Transferable[] }> =
    [];
  gate: Promise<void> | undefined;
  assets: RpcProxy<IFusedHtmlAssetService> | undefined;

  postMessage(message: unknown, ports: readonly Transferable[] = []): void {
    this.posted.push({ message, ports });
    const data = message as { readonly type?: string; readonly token?: string } | null;
    if (data === null || data.type !== HTML_VIEW_ASSETS) return;
    const [hostPort, reply] = ports;
    if (hostPort instanceof MessagePort) {
      // The worker answers its package reads on the port the editor created for it.
      const endpoint = createRpc(hostPort);
      this.assets = endpoint.getProxy(fusedHtmlAssetService);
      cleanup.push(() => endpoint.dispose());
    }
    const ack = (): void => {
      if (!(reply instanceof MessagePort)) return;
      reply.postMessage({ type: HTML_VIEW_ASSETS_ACK, token: data.token });
    };
    if (this.gate === undefined) ack();
    else void this.gate.then(ack);
  }

  /** One package request of the author document, as the worker answers it. */
  async readPackage(path: string): Promise<Uint8Array> {
    if (this.assets === undefined) throw new Error('the worker owns no package lane');
    return this.assets.read(path);
  }
}

class FakeWorkerContainer {
  readonly controller = new FakeWorker();
  readonly register = vi.fn(async () => undefined);

  addEventListener(): void {
    return undefined;
  }

  removeEventListener(): void {
    return undefined;
  }
}

class FakeOuterWindow {
  readonly document: FakeOuterDocument;
  readonly location = new URL(ENVIRONMENT_URL);
  readonly messages = new Set<(event: unknown) => void>();
  readonly pagehide = new Set<() => void>();
  readonly navigator: { serviceWorker: FakeWorkerContainer | undefined };
  readonly parent = { postMessage: vi.fn() };
  readonly workers: FakeWorkerContainer | undefined;

  constructor(withWorkers = true) {
    this.document = new FakeOuterDocument(this);
    this.workers = withWorkers ? new FakeWorkerContainer() : undefined;
    this.navigator = { serviceWorker: this.workers };
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'message') this.messages.add(listener);
    else if (type === 'pagehide') this.pagehide.add(listener as () => void);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'message') this.messages.delete(listener);
  }

  dispatchMessage(event: unknown): void {
    for (const listener of [...this.messages]) listener(event);
  }

  dispatch(type: string): void {
    if (type === 'pagehide') for (const listener of [...this.pagehide]) listener();
  }
}

// ---------------------------------------------------------------- editor host

/** Editor end of one view: the control lane plus the two lanes it grants on request. */
class FakeControl implements IFusedHtmlHostControlService {
  theme: IHtmlViewTheme = { appearance: 'dark', colors: WORKBENCH_DARK_COLORS };
  readonly themeListeners = new Set<(theme: IHtmlViewTheme) => void>();
  readonly closeListeners = new Set<() => void>();
  readonly failures: Array<{ readonly code: string; readonly message: string }> = [];
  readonly ready = vi.fn(async () => undefined);
  readonly closed = vi.fn();
  /** Reads of the outer page: its author document and nothing else. */
  readonly readAsset = vi.fn(async (path: string) => this.packageBytes(path));
  readonly getTheme = vi.fn(async (): Promise<IHtmlViewTheme> => this.theme);
  /** Reads of the package worker, answered by the editor without the outer page. */
  readonly packageReads: string[] = [];
  /** Reads of the inner author frame, answered by the editor without the outer page. */
  readonly authorReads: string[] = [];
  readonly endpoints: RpcEndpoint[] = [];
  assetPortCalls = 0;
  contentPortCalls = 0;
  private readonly target: IHtmlViewTarget;

  constructor(target: IHtmlViewTarget) {
    this.target = target;
  }

  async assetPort(): Promise<MessagePort> {
    this.assetPortCalls += 1;
    const channel = new MessageChannel();
    const endpoint = this.endpointOf(channel.port1);
    endpoint.register(fusedHtmlAssetService, {
      read: async (path: string) => {
        this.packageReads.push(path);
        return this.packageBytes(path);
      },
    });
    return channel.port2;
  }

  async contentPort(): Promise<MessagePort> {
    this.contentPortCalls += 1;
    const channel = new MessageChannel();
    const endpoint = this.endpointOf(channel.port1);
    endpoint.register(fusedHtmlHostService, {
      readAsset: async (path: string) => {
        this.authorReads.push(path);
        return this.packageBytes(path);
      },
      callModel: async () => null,
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      onDidModelEvent: () => () => undefined,
      onDidClose: (listener) => {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
      },
      reportFailure: async (code, message) => {
        this.failures.push({ code, message });
      },
    });
    endpoint.register(fusedHtmlContentViewService, {
      view: async () => ({ token: TOKEN, target: this.target }),
    });
    return channel.port2;
  }

  onDidThemeChange(listener: (theme: IHtmlViewTheme) => void): () => void {
    this.themeListeners.add(listener);
    return () => {
      this.themeListeners.delete(listener);
    };
  }

  async reportFailure(code: string, message: string): Promise<void> {
    this.failures.push({ code, message });
  }

  announce(theme: IHtmlViewTheme): void {
    this.theme = theme;
    for (const listener of [...this.themeListeners]) listener(theme);
  }

  dispose(): void {
    for (const endpoint of this.endpoints) endpoint.dispose();
    this.endpoints.length = 0;
  }

  private endpointOf(port: MessagePort): RpcEndpoint {
    const endpoint = createRpc(port);
    this.endpoints.push(endpoint);
    return endpoint;
  }

  /** Bytes of one package file of this fake view: the real entry, a uniform payload otherwise. */
  private packageBytes(path: string): Uint8Array {
    return new TextEncoder().encode(path === 'monitor/index.html' ? AUTHOR_HTML : `/* ${path} */`);
  }
}

interface IHarness {
  readonly started: Promise<void>;
  readonly outer: FakeOuterWindow;
  readonly host: FakeControl;
  readonly editor: RpcEndpoint;
  frame(): FakeFrame;
}

function handshakeMessage(): IHtmlViewConnectMessage {
  return {
    type: HTML_VIEW_CONNECT,
    token: TOKEN,
    parentOrigin: EDITOR_ORIGIN,
    target: {
      instanceId: 'led-1',
      viewId: 'monitor',
      device: 'test:led',
      title: 'Monitor',
      entry: 'monitor/index.html',
      assetRoot: ASSET_ROOT,
      props: { label: 'led' },
      methods: [],
      events: [],
      hasModel: false,
    },
  };
}

function harness(
  options: {
    readonly gate?: Promise<void>;
    readonly withWorkers?: boolean;
    readonly workerTimeoutMs?: number;
    readonly contentTimeoutMs?: number;
  } = {},
): IHarness {
  const outer = new FakeOuterWindow(options.withWorkers ?? true);
  vi.stubGlobal('window', outer);
  vi.stubGlobal('document', outer.document);
  const channel = new MessageChannel();
  const editor = createRpc(channel.port1);
  cleanup.push(() => editor.dispose());
  const host = new FakeControl(handshakeMessage().target);
  cleanup.push(() => host.dispose());
  // The editor creates the dedicated lanes, so it is the side that transfers their ports.
  editor.register(fusedHtmlHostControlService, host, {
    transfer: (_member, value) => (value instanceof MessagePort ? [value] : transferBytes(value)),
  });
  if (outer.workers !== undefined) outer.workers.controller.gate = options.gate;
  const started = startHtmlViewEnvironment({
    workerTimeoutMs: options.workerTimeoutMs ?? 10_000,
    // Deadline tests opt into a budget and advance a controlled clock.
    contentTimeoutMs: options.contentTimeoutMs ?? 0,
    contentUrl: `${ENVIRONMENT_ORIGIN}/p/__mica_view__/content.html`,
  });
  void started.catch(() => undefined);
  outer.dispatchMessage({
    type: 'message',
    data: handshakeMessage(),
    ports: [channel.port2],
    source: outer.parent,
    origin: EDITOR_ORIGIN,
  });
  return {
    started,
    outer,
    host,
    editor,
    frame() {
      const frame = outer.document.body.children.at(-1);
      if (frame === undefined) throw new Error('the environment created no content frame');
      return frame;
    },
  };
}

interface IContentBridge {
  readonly endpoint: RpcEndpoint;
  /** Author lane of the inner frame: the editor serves it directly. */
  readonly host: RpcProxy<IFusedHtmlHostService>;
  readonly identity: RpcProxy<IFusedHtmlContentViewService>;
  readonly token: string;
  /** Announces that the inner frame installed its API and its package grant. */
  prepared(): void;
}

/** Runs the inner bootstrap handshake of one environment and returns its author lane. */
async function bridge(run: IHarness): Promise<IContentBridge> {
  const frame = run.frame();
  frame.dispatch('load');
  const token = new URL(frame.src).searchParams.get(HTML_VIEW_FRAME_PARAM);
  if (token === null) throw new Error('the frame URL carries no token');
  frame.contentWindow.postToParent({ type: HTML_VIEW_CHILD_HELLO, token });
  await vi.waitFor(() => expect(frame.contentWindow.connectMessage()).toBeDefined());
  const connect = frame.contentWindow.connectMessage();
  if (connect === undefined) throw new Error('the environment did not hand over the bridge');
  const endpoint = createRpc(connect.port);
  cleanup.push(() => endpoint.dispose());
  return {
    endpoint,
    host: endpoint.getProxy(fusedHtmlHostService),
    identity: endpoint.getProxy(fusedHtmlContentViewService),
    token,
    prepared() {
      frame.contentWindow.postToParent({ type: HTML_VIEW_CHILD_PREPARED, token });
    },
  };
}

function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('HTML view environment bootstrap', () => {
  it('creates the inner frame from the real content document of the deployment', async () => {
    const run = harness();
    await run.started;
    const frame = run.frame();
    const url = new URL(frame.src);
    expect(url.origin).toBe(ENVIRONMENT_ORIGIN);
    expect(url.pathname).toBe('/p/__mica_view__/content.html');
    expect(url.searchParams.get(HTML_VIEW_FRAME_PARAM)).toMatch(/^[0-9a-f]{32}$/);
    expect(frame.attributes['sandbox']).toBe('allow-scripts allow-same-origin');
    // The trusted document keeps its own page: only the inner document is written later.
    expect(run.outer.document.open).not.toHaveBeenCalled();
    expect(run.outer.document.write).not.toHaveBeenCalled();
    expect(frame.contentDocument?.operations).toEqual([]);
    expect(run.outer.parent.postMessage).toHaveBeenCalledWith(
      { type: 'mica:view:ack', token: TOKEN },
      EDITOR_ORIGIN,
    );
    expect(run.host.readAsset).toHaveBeenCalledWith('monitor/index.html');
    // Nothing of the author frame exists before that frame announces itself.
    expect(run.host.contentPortCalls).toBe(0);
  });

  it('grants the package scope to the worker before any inner frame exists', async () => {
    const gate = deferred();
    const run = harness({ gate: gate.promise, workerTimeoutMs: 2_000 });
    await vi.waitFor(() => expect(run.outer.workers?.controller.posted.length).toBe(1));
    const grant = run.outer.workers?.controller.posted.at(-1);
    expect(grant?.message).toEqual({
      type: 'mica:view:assets',
      token: TOKEN,
      root: '/p/__mica_view__/__mica_package__/',
    });
    // The editor's package lane plus the reply port the worker acknowledges on.
    expect(grant?.ports).toHaveLength(2);
    expect(grant?.ports[0]).toBeInstanceOf(MessagePort);
    expect(grant?.ports[1]).toBeInstanceOf(MessagePort);
    expect(run.host.assetPortCalls).toBe(1);
    expect(run.outer.document.body.children).toHaveLength(0);
    gate.open();
    await run.started;
    expect(run.outer.document.body.children).toHaveLength(1);
  });

  it('reports a missing service worker as an explicit load failure', async () => {
    const run = harness({ withWorkers: false });
    await expect(run.started).rejects.toThrow('no service worker support');
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        {
          code: 'view/load-failed',
          message: 'This browser has no service worker support, so package files cannot load.',
        },
      ]),
    );
    expect(run.outer.document.body.children).toHaveLength(0);
  });

  it('paints the view background on this page and on the inner frame before it is appended', async () => {
    const run = harness();
    await run.started;
    // This trusted page shows the view background while it loads, so a delayed author document
    // never exposes a white surface.
    await vi.waitFor(() =>
      expect(run.outer.document.documentElement.style.properties.get('background-color')).toBe(
        WORKBENCH_DARK_COLORS['panel.background'],
      ),
    );
    expect(run.outer.document.body.appendedBackgrounds).toEqual([
      WORKBENCH_DARK_COLORS['panel.background'],
    ]);
    expect(run.frame().style['background']).toBe(WORKBENCH_DARK_COLORS['panel.background']);
  });

  it('follows a theme change while the inner bootstrap is still loading', async () => {
    const run = harness();
    await run.started;
    // No load event yet: `content.js` is still on its way, so only the live element can repaint.
    const frame = run.frame();
    await vi.waitFor(() => expect(run.host.themeListeners.size).toBe(1));
    run.host.announce({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
    await vi.waitFor(() =>
      expect(run.outer.document.documentElement.style.properties.get('background-color')).toBe(
        WORKBENCH_LIGHT_COLORS['panel.background'],
      ),
    );
    expect(frame.style['background']).toBe(WORKBENCH_LIGHT_COLORS['panel.background']);
    expect(frame.contentDocument?.operations).toEqual([]);
    expect(run.host.failures).toEqual([]);
  });

  it('paints the inner root once the bootstrap document is there', async () => {
    const run = harness();
    await run.started;
    const frame = run.frame();
    frame.dispatch('load');
    await vi.waitFor(() => expect(run.host.themeListeners.size).toBe(1));
    run.host.announce({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
    await vi.waitFor(() =>
      expect(frame.contentDocument?.documentElement.style.properties.get('background-color')).toBe(
        WORKBENCH_LIGHT_COLORS['panel.background'],
      ),
    );
  });

  it('writes the author document into the inner document once the frame is prepared', async () => {
    const run = harness();
    await run.started;
    const opened = await bridge(run);
    expect(opened.token).toMatch(/^[0-9a-f]{32}$/);
    const view = await opened.identity.view();
    expect(view.token).toBe(TOKEN);
    expect(view.target.entry).toBe('monitor/index.html');
    // The author document does not exist before the frame announced its API and package grant.
    const frame = run.frame();
    expect(frame.contentDocument?.writes).toEqual([]);

    opened.prepared();
    // The author error lane is installed after the open that clears window listeners and before
    // the write that lets author scripts run.
    expect(frame.contentDocument?.operations).toEqual([
      'open',
      'listen:error',
      'listen:unhandledrejection',
      'write',
      'close',
    ]);
    const html = frame.contentDocument?.writes[0] ?? '';
    expect(html).toContain(`<base href="${ASSET_ROOT}monitor/">`);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain(`--mica-bg:${WORKBENCH_DARK_COLORS['workbench.background']}`);
    expect(html).toContain('color-scheme:dark');
    expect(html.indexOf('--mica-bg')).toBeLessThan(html.indexOf('<title>'));
    expect(html).toContain('<p>monitor</p>');
    await vi.waitFor(() => expect(run.host.ready).toHaveBeenCalledOnce());
    expect(run.outer.document.write).not.toHaveBeenCalled();
  });

  it('mirrors the theme onto the written document and later changes in place', async () => {
    const run = harness();
    await run.started;
    const opened = await bridge(run);
    opened.prepared();
    const frame = run.frame();
    const root = frame.contentDocument?.documentElement;
    expect(root?.style.properties.get('--mica-bg')).toBe(
      WORKBENCH_DARK_COLORS['workbench.background'],
    );
    await vi.waitFor(() => expect(run.host.themeListeners.size).toBe(1));
    run.host.announce({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
    await vi.waitFor(() =>
      expect(frame.contentDocument?.documentElement.style.properties.get('--mica-bg')).toBe(
        WORKBENCH_LIGHT_COLORS['workbench.background'],
      ),
    );
    expect(frame.contentDocument?.documentElement.style.properties.get('color-scheme')).toBe(
      'light',
    );
    // No reload, no second write and no lost document.
    expect(frame.contentDocument?.operations).toEqual([
      'open',
      'listen:error',
      'listen:unhandledrejection',
      'write',
      'close',
    ]);
    expect(run.outer.document.body.children).toHaveLength(1);
    expect(frame.removed).toBe(false);
    expect(run.host.failures).toEqual([]);
  });

  it('does not lose a theme change that lands while the first snapshot is in flight', async () => {
    const run = harness();
    run.host.getTheme.mockImplementation(async () => {
      run.host.announce({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
      return { appearance: 'dark', colors: WORKBENCH_DARK_COLORS };
    });
    await run.started;
    const opened = await bridge(run);
    opened.prepared();
    const html = run.frame().contentDocument?.writes[0] ?? '';
    expect(html).toContain(`--mica-bg:${WORKBENCH_LIGHT_COLORS['workbench.background']}`);
    expect(html).toContain('color-scheme:light');
  });

  it('reports author failures through the lane installed after the document was opened', async () => {
    const run = harness();
    await run.started;
    const opened = await bridge(run);
    opened.prepared();
    const frame = run.frame();
    frame.contentWindow.deliver('error', { message: 'author exploded' });
    frame.contentWindow.deliver('unhandledrejection', { reason: new Error('promise exploded') });
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        { code: 'view/execution-failed', message: 'author exploded' },
        { code: 'view/execution-failed', message: 'promise exploded' },
      ]),
    );
  });

  it('accepts the document URL a browser repoints at the environment page during its own write', async () => {
    const run = harness();
    await run.started;
    const opened = await bridge(run);
    opened.prepared();
    const frame = run.frame();
    // `document.open()` keeps the window but repoints the document URL at the caller page; the
    // load that follows the write is therefore not a navigation.
    frame.contentWindow.location.href = ENVIRONMENT_URL;
    frame.dispatch('load');
    frame.dispatch('load');
    await vi.waitFor(() => expect(run.host.failures).toEqual([]));
    expect(frame.contentDocument?.operations).toEqual([
      'open',
      'listen:error',
      'listen:unhandledrejection',
      'write',
      'close',
    ]);
    await vi.waitFor(() => expect(run.host.ready).toHaveBeenCalledOnce(), { timeout: 5_000 });
  });

  it('fails exactly once when the inner frame navigates after the write', async () => {
    const run = harness();
    await run.started;
    const opened = await bridge(run);
    opened.prepared();
    const frame = run.frame();
    frame.navigate(`${ASSET_ROOT}monitor/index.html`);
    frame.dispatch('load');
    frame.dispatch('load');
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        {
          code: 'view/execution-failed',
          message: 'The HTML view navigated away from its author document.',
        },
      ]),
    );
  });

  it('fails when the frame does not load its content document first', async () => {
    const run = harness();
    await run.started;
    const frame = run.frame();
    // Same readable document, wrong URL: the first load is the only place the URL is trusted.
    frame.contentWindow.location.href = `${ASSET_ROOT}monitor/index.html`;
    frame.dispatch('load');
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        {
          code: 'view/execution-failed',
          message: 'The HTML view navigated away from its author document.',
        },
      ]),
    );
    expect(run.host.ready).not.toHaveBeenCalled();
  });

  it('fails when the frame leaves its content document before the write', async () => {
    const run = harness();
    await run.started;
    const frame = run.frame();
    frame.navigate('https://evil.example.com/content.html', { crossOrigin: true });
    frame.dispatch('load');
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        {
          code: 'view/execution-failed',
          message: 'The HTML view navigated away from its author document.',
        },
      ]),
    );
  });

  it('fails a second bootstrap of the inner frame instead of reopening the view', async () => {
    const run = harness();
    await run.started;
    const frame = run.frame();
    frame.dispatch('load');
    const token = new URL(frame.src).searchParams.get(HTML_VIEW_FRAME_PARAM) ?? '';
    frame.contentWindow.postToParent({ type: HTML_VIEW_CHILD_HELLO, token });
    await vi.waitFor(() => expect(frame.contentWindow.connectMessage()).toBeDefined(), {
      timeout: 5_000,
    });
    expect(run.host.failures).toEqual([]);

    // A reload of the content document starts the bootstrap again.
    frame.contentWindow.postToParent({ type: HTML_VIEW_CHILD_HELLO, token });
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        { code: 'view/execution-failed', message: 'The HTML view document started twice.' },
      ]),
    );
  });

  it('ignores a handshake from a foreign origin and fails after the budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = harness({ contentTimeoutMs: 50 });
    await run.started;
    const frame = run.frame();
    frame.dispatch('load');
    const token = new URL(frame.src).searchParams.get(HTML_VIEW_FRAME_PARAM) ?? '';
    frame.contentWindow.postToParent({ type: HTML_VIEW_CHILD_HELLO, token }, 'null');
    frame.contentWindow.postToParent(
      { type: HTML_VIEW_CHILD_HELLO, token },
      'https://evil.example.com',
    );
    expect(frame.contentWindow.connectMessage()).toBeUndefined();
    // A handshake of another origin never consumes the author port of this view.
    expect(run.host.contentPortCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(49);
    expect(run.host.failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        { code: 'view/execution-failed', message: 'The HTML view document did not start in time.' },
      ]),
    );
  });

  it('refuses a late hello of a view that already failed instead of granting a port', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = harness({ contentTimeoutMs: 50 });
    await run.started;
    const frame = run.frame();
    frame.dispatch('load');
    const token = new URL(frame.src).searchParams.get(HTML_VIEW_FRAME_PARAM) ?? '';
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() =>
      expect(run.host.failures).toEqual([
        { code: 'view/execution-failed', message: 'The HTML view document did not start in time.' },
      ]),
    );
    frame.contentWindow.postToParent({ type: HTML_VIEW_CHILD_HELLO, token });
    await vi.advanceTimersByTimeAsync(10);
    expect(run.host.contentPortCalls).toBe(0);
    expect(frame.contentWindow.connectMessage()).toBeUndefined();
    expect(run.host.failures).toHaveLength(1);
  });

  it('serves the inner frame from the editor without forwarding through this page', async () => {
    const run = harness();
    await run.started;
    const opened = await bridge(run);
    // The author frame reads its own package files and its own identity on the granted lane.
    await expect(opened.host.readAsset('monitor/panel.css')).resolves.toEqual(
      new TextEncoder().encode('/* monitor/panel.css */'),
    );
    expect(run.host.authorReads).toEqual(['monitor/panel.css']);
    const view = await opened.identity.view();
    expect(view.target.instanceId).toBe('led-1');
    // The outer page of the view read its author document and relayed the theme; no author read
    // and no model call of the frame passed through it.
    expect(run.host.readAsset.mock.calls).toEqual([['monitor/index.html']]);
    expect(run.host.contentPortCalls).toBe(1);
    // The close announcement of the editor reaches the author frame over the same lane.
    const closed: number[] = [];
    opened.host.onDidClose(() => closed.push(1));
    await vi.waitFor(() => expect(run.host.closeListeners.size).toBe(1), { timeout: 5_000 });
    for (const listener of [...run.host.closeListeners]) listener();
    await vi.waitFor(() => expect(closed).toEqual([1]));
  });

  it('answers the package requests of the worker on the port the editor granted', async () => {
    const run = harness();
    await run.started;
    const worker = run.outer.workers?.controller;
    if (worker === undefined) throw new Error('the environment has no worker');
    await expect(worker.readPackage('monitor/panel.css')).resolves.toEqual(
      new TextEncoder().encode('/* monitor/panel.css */'),
    );
    // The worker read the package on the editor lane, never through the outer page.
    expect(run.host.packageReads).toEqual(['monitor/panel.css']);
    expect(run.host.readAsset.mock.calls).toEqual([['monitor/index.html']]);
    expect(run.host.assetPortCalls).toBe(1);
  });

  it('refuses to write when the inner document is unavailable', async () => {
    const run = harness();
    await run.started;
    const opened = await bridge(run);
    run.frame().contentDocument = null;
    opened.prepared();
    await vi.waitFor(
      () =>
        expect(run.host.failures).toEqual([
          {
            code: 'view/execution-failed',
            message: 'The HTML view document frame is not available.',
          },
        ]),
      { timeout: 5_000 },
    );
    expect(run.host.ready).not.toHaveBeenCalled();
  });

  it('announces a closed environment on pagehide', async () => {
    const run = harness();
    await run.started;
    run.outer.dispatch('pagehide');
    await vi.waitFor(() => expect(run.host.closed).toHaveBeenCalledOnce());
  });
});
