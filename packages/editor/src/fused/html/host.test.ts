import { timePs } from '@mica-js/core';
import { Emitter } from '@mica-js/core/lifecycle';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcProxy, RpcServiceId } from '@mica-js/core/rpc';
import type {
  DeviceLock,
  DeviceRegistry,
  PackageFiles,
  UnifiedDeviceManifest,
  Value,
} from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IFusedModelClient } from '../runtime/protocol';
import { WORKBENCH_DARK_COLORS, WORKBENCH_LIGHT_COLORS } from '../theme';
import { createHtmlViewHost } from './host';
import type { IHtmlViewHandle, IHtmlViewHost, IHtmlViewInstance } from './host';
import {
  HTML_VIEW_ACK,
  fusedHtmlAssetService,
  fusedHtmlContentViewService,
  fusedHtmlHostControlService,
  fusedHtmlHostService,
} from './protocol';
import type {
  IFusedHtmlAssetService,
  IFusedHtmlContentViewService,
  IFusedHtmlHostControlService,
  IFusedHtmlHostService,
  IFusedHtmlModelEventWire,
  IHtmlViewConnectMessage,
} from './protocol';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const EDITOR_ORIGIN = 'https://editor.example.com';
const TEMPLATE = 'https://${id}.cdn.example.com/p/__mica_view__/';
const DEVICE = 'test:lamp';

const MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'lamp',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Lamp',
  properties: {},
  pins: {},
  view: {
    serial: { title: 'Serial', entry: 'views/serial/index.html', defaultLocation: 'floating' },
    registers: { title: 'Registers', entry: 'views/registers/index.html' },
  },
};

const PACKAGE_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify(MANIFEST, null, 2),
  'views/serial/index.html': '<!doctype html><html><head><title>Serial</title></head></html>',
  'views/serial/main.js': 'export const ready = true;',
  'views/registers/index.html': '<!doctype html><html><head></head></html>',
};

// ---------------------------------------------------------------- fixtures

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `sha256:${hex.join('')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

interface IFixture {
  readonly registry: DeviceRegistry;
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  lock: DeviceLock;
}

async function fixture(files: Readonly<Record<string, string>> = PACKAGE_FILES): Promise<IFixture> {
  const encoded = new Map<string, Uint8Array>();
  const table: Record<string, { size: number; integrity: string }> = {};
  for (const [path, content] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(content);
    encoded.set(path, bytes);
    table[path] = { size: bytes.length, integrity: await sha256(content) };
  }
  const integrity = await sha256(
    canonicalJson({ id: DEVICE, version: MANIFEST.version, files: table }),
  );
  const lock: DeviceLock = { id: DEVICE, version: MANIFEST.version, integrity };
  const opened: PackageFiles = {
    lock,
    files: table,
    read: async (path: string) => {
      const bytes = encoded.get(path);
      if (bytes === undefined) throw new Error(`unknown file ${path}`);
      return bytes.slice();
    },
  };
  return { registry: { open: async () => opened }, bytes: encoded, lock };
}

// ---------------------------------------------------------------- fake DOM

interface IFakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

class FakeWindow {
  readonly posted: Array<{ message: unknown; origin: string; transfer: readonly Transferable[] }> =
    [];
  readonly listeners = new Set<(event: unknown) => void>();
  innerWidth = 1000;
  innerHeight = 800;

  getComputedStyle(node: FakeElement): { overflowX: string; overflowY: string } {
    return { overflowX: node.overflow.x, overflowY: node.overflow.y };
  }

  postMessage(message: unknown, origin: string, transfer: readonly Transferable[] = []): void {
    this.posted.push({ message, origin, transfer });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  dispatchMessage(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

class FakeElement {
  readonly tagName: string;
  className = '';
  title = '';
  src = '';
  removed = false;
  focused = 0;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  contentWindow: FakeWindow | null = null;
  rect: IFakeRect = { left: 0, top: 0, width: 0, height: 0 };
  overflow: { x: string; y: string } = { x: 'visible', y: 'visible' };
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName;
    if (tagName === 'iframe') this.contentWindow = new FakeWindow();
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    this.removed = true;
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  get parentElement(): FakeElement | null {
    return this.parent;
  }

  get clientLeft(): number {
    return this.border;
  }

  get clientTop(): number {
    return this.border;
  }

  get clientWidth(): number {
    return Math.max(0, this.rect.width - this.border * 2);
  }

  get clientHeight(): number {
    return Math.max(0, this.rect.height - this.border * 2);
  }

  border = 0;

  getBoundingClientRect(): IFakeRect {
    return this.rect;
  }

  addEventListener(type: string, listener: () => void): void {
    let entries = this.listeners.get(type);
    if (entries === undefined) this.listeners.set(type, (entries = new Set()));
    entries.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  focus(): void {
    this.focused += 1;
  }
}

interface IHarness {
  readonly host: IHtmlViewHost;
  readonly container: FakeElement;
  readonly editorWindow: FakeWindow;
  readonly created: FakeElement[];
  readonly failures: string[];
  readonly models: Map<string, IFusedModelClient>;
  readonly instances: Map<string, IHtmlViewInstance>;
  readonly endpoints: RpcEndpoint[];
  /** Replaces the package registry the manager verifies views against. */
  setRegistry(registry: DeviceRegistry): void;
  open(viewId?: string, options?: { readonly timeoutMs?: number }): ReturnType<typeof openView>;
  dispose(): Promise<void>;
}

/** One dedicated lane the test end of the editor opened on a granted port. */
interface ILane<T extends object> {
  readonly endpoint: RpcEndpoint;
  readonly proxy: RpcProxy<T>;
}

interface IOpenView {
  readonly handle: IHtmlViewHandle;
  readonly frame: FakeElement;
  readonly window: FakeWindow;
  readonly message: IHtmlViewConnectMessage;
  /** Control lane the environment page holds: lifecycle, theme and the two port grants. */
  readonly control: RpcProxy<IFusedHtmlHostControlService>;
  readonly endpoint: RpcEndpoint;
  /** Author lane of the inner frame, requested once through the control lane. */
  author(): Promise<
    ILane<IFusedHtmlHostService> & { identity: RpcProxy<IFusedHtmlContentViewService> }
  >;
  /** Package lane of the environment's asset worker, requested once through the control lane. */
  package(): Promise<ILane<IFusedHtmlAssetService>>;
}

/** Connects the test end of one granted dedicated port. */
async function lane<T extends object>(
  request: () => Promise<MessagePort>,
  service: RpcServiceId<T>,
  endpoints: RpcEndpoint[],
): Promise<ILane<T>> {
  const endpoint = createRpc(await request());
  endpoints.push(endpoint);
  return { endpoint, proxy: endpoint.getProxy(service) };
}

async function openView(
  host: IHtmlViewHost,
  created: FakeElement[],
  endpoints: RpcEndpoint[],
  viewId: string,
): Promise<IOpenView> {
  const handle = await host.open({ instanceId: INSTANCE_ID, viewId, location: 'sidebar' });
  const frame = created.filter((element) => element.tagName === 'iframe').at(-1);
  if (frame === undefined || frame.contentWindow === null) throw new Error('no iframe yet');
  frame.dispatch('load');
  const posted = frame.contentWindow.posted.at(-1);
  if (posted === undefined) throw new Error('no handshake was posted');
  const port = posted.transfer[0];
  if (!(port instanceof MessagePort)) throw new Error('the handshake transferred no port');
  const endpoint = createRpc(port);
  endpoints.push(endpoint);
  const control = endpoint.getProxy(fusedHtmlHostControlService);
  let authorLane:
    | Promise<ILane<IFusedHtmlHostService> & { identity: RpcProxy<IFusedHtmlContentViewService> }>
    | undefined;
  let packageLane: Promise<ILane<IFusedHtmlAssetService>> | undefined;
  return {
    handle,
    frame,
    window: frame.contentWindow,
    message: posted.message as IHtmlViewConnectMessage,
    control,
    endpoint,
    author() {
      authorLane ??= lane(() => control.contentPort(), fusedHtmlHostService, endpoints).then(
        (opened) => ({
          ...opened,
          identity: opened.endpoint.getProxy(fusedHtmlContentViewService),
        }),
      );
      return authorLane;
    },
    package() {
      packageLane ??= lane(() => control.assetPort(), fusedHtmlAssetService, endpoints);
      return packageLane;
    },
  };
}

function harness(
  options: {
    readonly instances?: Map<string, IHtmlViewInstance>;
    readonly handshakeTimeoutMs?: number;
    readonly model?: IFusedModelClient;
    /** Leaves the manager without a model source, to prove a declared model is never faked. */
    readonly withoutModel?: boolean;
    /** Replaces the model source entirely, e.g. to make it throw like a released session. */
    readonly modelSource?: (instanceId: string) => IFusedModelClient | undefined;
    /** Makes the declaration callback throw, to prove the error is not reported as "not mounted". */
    readonly describeThrows?: Error;
  } = {},
): IHarness {
  const instance: IHtmlViewInstance = {
    device: DEVICE,
    lock: { id: DEVICE, version: MANIFEST.version, integrity: `sha256:${'0'.repeat(64)}` },
    props: { label: 'lamp' },
    methods: ['getOn', 'setOn'],
    events: ['onDidChange'],
    hasModel: true,
    views: MANIFEST.view ?? {},
  };
  const instances = options.instances ?? new Map([[INSTANCE_ID, instance]]);
  const created: FakeElement[] = [];
  const failures: string[] = [];
  const container = new FakeElement('div');
  const editorWindow = new FakeWindow();
  const fakeDocument = {
    createElement: (tagName: string) => {
      const element = new FakeElement(tagName);
      created.push(element);
      return element;
    },
  };
  let registry: DeviceRegistry = { open: async () => Promise.reject(new Error('no package')) };
  const models = new Map<string, IFusedModelClient>();
  if (options.withoutModel !== true) models.set(INSTANCE_ID, options.model ?? fakeModel().client);
  const host = createHtmlViewHost({
    viewBaseUrlTemplate: TEMPLATE,
    container: container as unknown as HTMLElement,
    describe: (instanceId) => {
      if (options.describeThrows !== undefined) throw options.describeThrows;
      return instances.get(instanceId);
    },
    registry: {
      open: (lock) => registry.open(lock),
    },
    ...(options.modelSource !== undefined
      ? { model: options.modelSource }
      : options.withoutModel === true
        ? {}
        : { model: (instanceId: string) => models.get(instanceId) }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    onDiagnostic: (failure) => failures.push(`${failure.code}:${failure.message}`),
    origin: EDITOR_ORIGIN,
    document: fakeDocument as unknown as Document,
    window: editorWindow as unknown as Window,
    createEnvironmentId: () => 'mica-0123456789abcdef',
  });
  const endpoints: RpcEndpoint[] = [];
  return {
    host,
    container,
    editorWindow,
    created,
    failures,
    models,
    instances,
    endpoints,
    setRegistry(next) {
      registry = next;
    },
    async open(viewId = 'serial', openOptions?: { readonly timeoutMs?: number }) {
      const result = await openView(host, created, endpoints, viewId);
      if (openOptions?.timeoutMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, openOptions.timeoutMs));
      }
      return result;
    },
    async dispose() {
      for (const endpoint of endpoints) endpoint.dispose();
      await host.dispose();
    },
  };
}

/** Binds the instance to the real lock of a verified fixture package. */
function usePackage(harnessed: IHarness, data: IFixture): void {
  const instance = harnessed.instances.get(INSTANCE_ID);
  if (instance === undefined) throw new Error('no instance');
  harnessed.instances.set(INSTANCE_ID, { ...instance, lock: data.lock });
  harnessed.setRegistry(data.registry);
}

function wireCode(error: unknown): string {
  if (!(error instanceof Error)) return 'not-an-error';
  try {
    const payload = JSON.parse(error.message) as { readonly code?: unknown };
    return typeof payload.code === 'string' ? payload.code : error.name;
  } catch {
    return error.name;
  }
}

const pending: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (pending.length > 0) await pending.pop()!();
});

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : `unexpected:${String(error)}`;
  }
  return 'resolved';
}

function ack(
  harnessed: IHarness,
  open: IOpenView,
  overrides: Partial<{ token: string; origin: string; source: unknown }> = {},
): void {
  // Cross-origin frames post their handshake answer to the embedding editor window.
  harnessed.editorWindow.dispatchMessage({
    type: 'message',
    data: { type: HTML_VIEW_ACK, token: overrides.token ?? open.message.token },
    origin: overrides.origin ?? new URL(open.frame.src).origin,
    source: overrides.source ?? open.window,
  });
}

describe('createHtmlViewHost', () => {
  it('creates one environment on its own origin with the declared entry', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    usePackage(harnessed, await fixture());
    const opened = await harnessed.open();

    const environmentUrl = new URL(opened.frame.src);
    expect(environmentUrl.origin).toBe('https://mica-0123456789abcdef.cdn.example.com');
    expect(environmentUrl.pathname).toBe('/p/__mica_view__/index.html');
    // No theme snapshot in the URL: the element below is the loading surface and stays live.
    expect(environmentUrl.search).toBe('');
    expect(opened.frame.attributes['sandbox']).toBe('allow-scripts allow-same-origin');
    expect(opened.message.type).toBe('mica:view:connect');
    expect(opened.message.token).toMatch(/^[0-9a-f]{32}$/);
    expect(opened.message.parentOrigin).toBe(EDITOR_ORIGIN);
    expect(opened.message.target).toEqual({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      device: DEVICE,
      title: 'Serial',
      entry: 'views/serial/index.html',
      assetRoot: 'https://mica-0123456789abcdef.cdn.example.com/p/__mica_view__/__mica_package__/',
      props: { label: 'lamp' },
      methods: ['getOn', 'setOn'],
      events: ['onDidChange'],
      hasModel: true,
    });
    expect(opened.handle.state).toBe('loading');
    expect(harnessed.container.children.map((child) => child.className)).toContain(
      'mica-html-view-layer',
    );
  });

  it('rejects views the device does not declare and instances that are not mounted', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    usePackage(harnessed, await fixture());
    expect(
      await codeOf(async () =>
        harnessed.host.open({ instanceId: INSTANCE_ID, viewId: 'missing', location: 'sidebar' }),
      ),
    ).toBe('view/unknown-entry');
    expect(
      await codeOf(async () =>
        harnessed.host.open({ instanceId: 'other', viewId: 'serial', location: 'sidebar' }),
      ),
    ).toBe('view/unavailable-mode');
    expect(harnessed.created).toHaveLength(0);
  });

  it('refuses an entry the verified package does not declare', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    const instance = harnessed.instances.get(INSTANCE_ID);
    if (instance === undefined) throw new Error('no instance');
    const files = { ...PACKAGE_FILES };
    delete files['views/registers/index.html'];
    usePackage(harnessed, await fixture(files));
    harnessed.instances.set(INSTANCE_ID, {
      ...instance,
      views: { registers: { title: 'Registers', entry: 'views/registers/index.html' } },
    });
    expect(await codeOf(async () => harnessed.open('registers'))).toBe('view/load-failed');
    expect(harnessed.created).toHaveLength(0);
  });

  it('serves the direct author and package lanes without a forwarding page', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const bytes = new TextEncoder().encode('export const ready = true;');
    // The outer page reads the one file it has to write itself over its control lane...
    await expect(opened.control.readAsset('views/serial/index.html')).resolves.toBeInstanceOf(
      Uint8Array,
    );
    // ...while the author frame and the asset worker are served by the host directly.
    const author = await opened.author();
    await expect(author.proxy.readAsset('views/serial/main.js')).resolves.toEqual(bytes);
    const worker = await opened.package();
    await expect(worker.proxy.read('views/serial/main.js')).resolves.toEqual(bytes);
    // Both direct lanes are bound to the same view lease: only declared files resolve.
    for (const path of ['package.json.bak', '../escape.js']) {
      expect(wireCode(await rejectionOf(() => author.proxy.readAsset(path)))).toBe(
        'view/load-failed',
      );
      expect(wireCode(await rejectionOf(() => worker.proxy.read(path)))).toBe('view/load-failed');
    }
  });

  it('gives the author lane the identity of this view, not a copy of the outer handshake', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const author = await opened.author();
    await expect(author.identity.view()).resolves.toEqual({
      token: opened.message.token,
      target: opened.message.target,
    });
    expect(opened.message.target.props).toEqual({ label: 'lamp' });
  });

  it('keeps model calls off the control lane of the environment page', async () => {
    const model = fakeModel();
    const harnessed = harness({ model: model.client });
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const control = opened.control as unknown as {
      callModel(method: string, params: Value): Promise<Value>;
    };
    // The lane the outer page holds has no model member, so nothing it sends reaches the lease.
    const failure = await rejectionOf(() => control.callModel('getOn', null));
    expect((failure as Error).name).toBe('MethodNotFound');
    expect(model.calls).toEqual([]);
  });

  it('grants each dedicated lane once and closes both when the view is released', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const author = await opened.author();
    const worker = await opened.package();
    // A second request would silently leave the first consumer on a dead port.
    expect(wireCode(await rejectionOf(() => opened.control.contentPort()))).toBe(
      'view/bridge-failed',
    );
    expect(wireCode(await rejectionOf(() => opened.control.assetPort()))).toBe(
      'view/bridge-failed',
    );

    const retired = [
      closedOf(opened.endpoint),
      closedOf(author.endpoint),
      closedOf(worker.endpoint),
    ];
    opened.handle.close();
    await Promise.all(retired);
    // Every lane of the lease is closed, so nothing a consumer still holds can reach the model.
    for (const call of [
      () => author.proxy.readAsset('views/serial/main.js'),
      () => worker.proxy.read('views/serial/main.js'),
      () => opened.control.assetPort(),
    ]) {
      const failure = await rejectionOf(call);
      expect((failure as Error).name).toBe('RpcDisconnectedError');
    }
  });

  it('faults the view when a dedicated lane closes instead of granting another port', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const author = await opened.author();
    // The inner document is gone without the control lane closing: an explicit fault, no re-grant.
    author.endpoint.dispose();
    await vi.waitFor(() => expect(opened.handle.state).toBe('failed'), { timeout: 5_000 });
    expect(opened.handle.failure?.code).toBe('view/bridge-failed');
    expect(opened.handle.failure?.message).toContain('dedicated author port');
    expect(harnessed.host.get(INSTANCE_ID, 'serial')).toBe(opened.handle);
    expect(opened.frame.removed).toBe(true);
  });

  it('calls the live model and pushes the events the view subscribed to', async () => {
    const model = fakeModel();
    const harnessed = harness({ model: model.client });
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const author = (await opened.author()).proxy;
    const received: IFusedHtmlModelEventWire[] = [];
    const stop = author.onDidModelEvent((event) => received.push(event));

    await author.subscribe('onDidChange');
    model.fire(1);
    await settle();
    expect(received.map((event) => event.payload.value)).toEqual([1]);
    await author.unsubscribe('onDidChange');
    model.fire(2);
    await settle();
    expect(received).toHaveLength(1);

    await expect(author.callModel('getOn', null)).resolves.toBe(true);
    expect(model.calls).toEqual([{ method: 'getOn', params: null }]);
    expect(wireCode(await rejectionOf(() => author.callModel('explode', null)))).toBe(
      'view/execution-failed',
    );
    expect(wireCode(await rejectionOf(() => author.subscribe('onDidNope')))).toBe(
      'view/execution-failed',
    );
    stop();
  });

  it('releases the environment when the view reports an author failure', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const author = await opened.author();
    // The report is fire-and-forget: the reply races the teardown it triggers.
    void author.proxy
      .reportFailure('view/execution-failed', 'author exploded')
      .catch(() => undefined);
    await settle();
    expect(opened.handle.state).toBe('failed');
    expect(opened.handle.failure).toEqual({
      code: 'view/execution-failed',
      message: 'author exploded',
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      title: 'Serial',
      device: DEVICE,
    });
    expect(harnessed.failures).toEqual(['view/execution-failed:author exploded']);
    expect(opened.frame.removed).toBe(true);
    expect(wireCode(await rejectionOf(() => author.proxy.readAsset('views/serial/main.js')))).toBe(
      'RpcDisconnectedError',
    );
  });

  it('retains one failed view instead of starting a new environment behind it', async () => {
    const harnessed = harness({ handshakeTimeoutMs: 20 });
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    expect(opened.handle.state).toBe('loading');
    await settle(60);
    expect(opened.handle.state).toBe('failed');
    expect(opened.handle.failure?.code).toBe('view/bridge-failed');

    // A container that re-runs its open effect while the problem is listed must not build a second
    // environment with a fresh origin behind the failure.
    const again = await harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'sidebar',
    });
    expect(again).toBe(opened.handle);
    expect(again.state).toBe('failed');
    // A failed view never paints its frame: its surface stays with the container.
    expect(opened.frame.style['visibility']).toBe('hidden');
    expect(harnessed.host.get(INSTANCE_ID, 'serial')).toBe(opened.handle);
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(1);
    expect(harnessed.failures).toEqual([
      'view/bridge-failed:The HTML environment did not answer the bridge handshake.',
    ]);

    // Only an explicit release retires the failure and permits a new environment.
    expect(harnessed.host.close(INSTANCE_ID, 'serial')).toBe(true);
    expect(harnessed.host.get(INSTANCE_ID, 'serial')).toBeUndefined();
    const reopened = await harnessed.open();
    expect(reopened.handle.state).toBe('loading');
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(2);
  });

  it('ignores a stale handshake and fails the view after the budget', async () => {
    const harnessed = harness({ handshakeTimeoutMs: 20 });
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    ack(harnessed, opened, { token: 'stale' });
    ack(harnessed, opened, { origin: 'https://evil.example.com' });
    expect(opened.handle.state).toBe('loading');
    await settle(60);
    expect(opened.handle.state).toBe('failed');
    expect(opened.handle.failure?.code).toBe('view/bridge-failed');
  });

  it('accepts the handshake of the environment and leaves the loading state on ready', async () => {
    const harnessed = harness({ handshakeTimeoutMs: 20 });
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    ack(harnessed, opened);
    await settle(60);
    expect(opened.handle.state).toBe('loading');
    await opened.control.ready();
    expect(opened.handle.state).toBe('ready');
    expect(harnessed.failures).toEqual([]);
  });

  it('opens one environment per view and focuses it instead of reloading', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const again = await harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'floating',
    });
    expect(again).toBe(opened.handle);
    expect(again.location).toBe('floating');
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(1);
    expect(opened.frame.focused).toBe(1);
    expect(opened.frame.contentWindow?.posted).toHaveLength(1);
  });

  it('positions the stable owner instead of moving it', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    const sidebar = new FakeElement('aside');
    sidebar.rect = { left: 20, top: 30, width: 320, height: 480 };
    opened.handle.attach(sidebar as unknown as HTMLElement);
    expect(opened.handle.element.style['left']).toBe('20px');
    expect(opened.handle.element.style['top']).toBe('30px');
    expect(opened.handle.element.style['width']).toBe('320px');
    expect(opened.handle.element.style['display']).toBe('block');

    const floating = new FakeElement('section');
    floating.rect = { left: 100, top: 60, width: 400, height: 300 };
    opened.handle.attach(floating as unknown as HTMLElement);
    expect(opened.handle.element.style['left']).toBe('100px');
    expect(opened.handle.element.style['width']).toBe('400px');
    expect(opened.handle.element.children).toContain(opened.frame);
    expect(opened.frame.removed).toBe(false);

    opened.handle.setVisible(false);
    expect(opened.handle.element.style['display']).toBe('none');
    opened.handle.setVisible(true);
    expect(opened.handle.element.style['display']).toBe('block');
    opened.handle.attach(null);
    expect(opened.handle.element.style['display']).toBe('none');
  });

  it('clips the stable owner to the visible part of a partially scrolled slot', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    harnessed.container.rect = { left: 0, top: 0, width: 1000, height: 800 };

    const scroller = new FakeElement('div');
    scroller.overflow = { x: 'hidden', y: 'auto' };
    scroller.rect = { left: 0, top: 0, width: 340, height: 200 };
    const slot = new FakeElement('div');
    scroller.append(slot);

    // The slot starts below the visible content box of the sidebar.
    slot.rect = { left: 20, top: 120, width: 300, height: 400 };
    opened.handle.attach(slot as unknown as HTMLElement);
    expect(opened.handle.element.style['left']).toBe('20px');
    expect(opened.handle.element.style['top']).toBe('120px');
    expect(opened.handle.element.style['width']).toBe('300px');
    expect(opened.handle.element.style['height']).toBe('400px');
    expect(opened.handle.element.style['clipPath']).toBe('inset(0px 0px 320px 0px)');

    // Scrolling the sidebar leaves the owner over the slot but clips what moved out of view.
    slot.rect = { left: 20, top: -50, width: 300, height: 400 };
    harnessed.host.refresh();
    expect(opened.handle.element.style['top']).toBe('-50px');
    expect(opened.handle.element.style['clipPath']).toBe('inset(50px 0px 150px 0px)');
    expect(opened.handle.element.style['display']).toBe('block');
    expect(opened.frame.removed).toBe(false);

    // The whole slot scrolled away: nothing of the environment may paint.
    slot.rect = { left: 20, top: -420, width: 300, height: 400 };
    harnessed.host.refresh();
    expect(opened.handle.element.style['display']).toBe('none');

    // Back in view yields the unclipped owner again, without a new iframe.
    slot.rect = { left: 20, top: 10, width: 300, height: 150 };
    harnessed.host.refresh();
    expect(opened.handle.element.style['clipPath']).toBe('none');
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(1);
  });
  it('leaves the loading state once the author document of the inner frame is ready', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    ack(harnessed, opened);
    expect(opened.handle.state).toBe('loading');
    await opened.control.ready();
    expect(opened.handle.state).toBe('ready');
    expect(harnessed.host.get(INSTANCE_ID, 'serial')).toBe(opened.handle);
    expect(opened.frame.removed).toBe(false);
  });

  it('treats a navigation of the environment as a closed view', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    ack(harnessed, opened);
    await opened.control.ready();
    opened.frame.dispatch('load');
    expect(opened.handle.state).toBe('closed');
    expect(harnessed.host.get(INSTANCE_ID, 'serial')).toBeUndefined();
    expect(opened.frame.removed).toBe(true);
  });

  it('mirrors a complete dark theme when the workbench forwards none', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    await expect(opened.control.getTheme()).resolves.toEqual({
      appearance: 'dark',
      colors: WORKBENCH_DARK_COLORS,
    });
    expect(harnessed.host.theme).toEqual({ appearance: 'dark', colors: WORKBENCH_DARK_COLORS });
  });

  it('pushes a theme change into every open environment without reloading it', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const serial = await harnessed.open('serial');
    const registers = await harnessed.open('registers');
    const seen: string[] = [];
    const announced: string[] = [];
    const subscription = harnessed.host.onDidThemeChange((theme) =>
      announced.push(theme.appearance),
    );
    serial.control.onDidThemeChange((theme) => seen.push(theme.appearance));
    registers.control.onDidThemeChange((theme) => seen.push(theme.appearance));
    await settle(20);

    harnessed.host.setTheme({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
    await settle(20);
    expect(seen).toEqual(['light', 'light']);
    expect(announced).toEqual(['light']);
    await expect(serial.control.getTheme()).resolves.toEqual({
      appearance: 'light',
      colors: WORKBENCH_LIGHT_COLORS,
    });

    // The same theme again is not a change: no event, no new frame, no lost author state.
    harnessed.host.setTheme({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
    await settle(20);
    expect(seen).toEqual(['light', 'light']);
    expect(announced).toEqual(['light']);
    expect(serial.frame.removed).toBe(false);
    expect(registers.frame.removed).toBe(false);
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(2);
    subscription.dispose();
  });

  it('paints the resolved view background before the environment is attached', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    // The slot keeps painting its themed surface (and its status text) while the frame paints
    // nothing: the owner of a loading view stays transparent and the frame stays hidden, because a
    // child document paints white until its own theme is applied.
    expect(opened.frame.style['background']).toBe(WORKBENCH_DARK_COLORS['panel.background']);
    expect(opened.handle.element.style['background']).toBe('transparent');
    expect(opened.frame.style['visibility']).toBe('hidden');

    // A theme change while loading still repaints the frame and reaches the environment, but the
    // owner of the loading view stays transparent.
    harnessed.host.setTheme({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
    expect(opened.frame.style['background']).toBe(WORKBENCH_LIGHT_COLORS['panel.background']);
    expect(opened.handle.element.style['background']).toBe('transparent');

    harnessed.host.setTheme({
      appearance: 'dark',
      colors: { ...WORKBENCH_DARK_COLORS, 'panel.background': 'rgb(18, 52, 86)' },
    });
    expect(opened.frame.style['background']).toBe('rgb(18, 52, 86)');
    expect(opened.handle.element.style['background']).toBe('transparent');
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(1);

    // Attaching, resizing or showing the slot never reveals the unthemed document.
    const slot = new FakeElement('aside');
    slot.rect = { left: 10, top: 20, width: 320, height: 480 };
    opened.handle.attach(slot as unknown as HTMLElement);
    opened.handle.setVisible(false);
    opened.handle.setVisible(true);
    expect(opened.frame.style['visibility']).toBe('hidden');
    expect(opened.handle.element.style['display']).toBe('block');
    expect(opened.handle.element.style['background']).toBe('transparent');

    // Ready hands the surface to the owner with the theme that is current now, then reveals.
    await opened.control.ready();
    expect(opened.frame.style['visibility']).toBe('visible');
    expect(opened.handle.element.style['background']).toBe('rgb(18, 52, 86)');
  });

  it('opens a later environment with the theme that is current', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    harnessed.host.setTheme({ appearance: 'light', colors: WORKBENCH_LIGHT_COLORS });
    const opened = await harnessed.open();
    await expect(opened.control.getTheme()).resolves.toEqual({
      appearance: 'light',
      colors: WORKBENCH_LIGHT_COLORS,
    });
  });

  it('rejects a theme that cannot be placed in the author document', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    expect(() =>
      harnessed.host.setTheme({
        appearance: 'dark',
        colors: { ...WORKBENCH_DARK_COLORS, border: 'red;}body{display:none' },
      }),
    ).toThrow('must be a plain CSS color');
    expect(() =>
      harnessed.host.setTheme({
        appearance: 'dark',
        colors: { ...WORKBENCH_DARK_COLORS, border: '' },
      }),
    ).toThrow('must be a non-empty CSS color');
    expect(harnessed.host.theme.appearance).toBe('dark');
    await expect(opened.control.getTheme()).resolves.toEqual({
      appearance: 'dark',
      colors: WORKBENCH_DARK_COLORS,
    });
  });

  it('closes every environment on dispose and keeps the manager usable after closeAll', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const serial = await harnessed.open('serial');
    const registers = await harnessed.open('registers');
    expect(harnessed.host.views).toHaveLength(2);
    harnessed.host.closeAll();
    expect(serial.handle.state).toBe('closed');
    expect(registers.handle.state).toBe('closed');
    expect(harnessed.host.views).toEqual([]);

    const reopened = await harnessed.open('serial');
    expect(reopened.handle.state).toBe('loading');
    await harnessed.host.dispose();
    expect(reopened.handle.state).toBe('closed');
    expect(reopened.frame.removed).toBe(true);
    expect(harnessed.container.children).toHaveLength(0);
    expect(harnessed.host.views).toEqual([]);
  });

  it('keeps the model of a declaration whose public surface is empty', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    const instance = harnessed.instances.get(INSTANCE_ID);
    if (instance === undefined) throw new Error('no instance');
    harnessed.instances.set(INSTANCE_ID, { ...instance, hasModel: true, methods: [], events: [] });
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    expect(opened.message.target.hasModel).toBe(true);
    expect(opened.message.target.methods).toEqual([]);
    const author = (await opened.author()).proxy;
    await expect(author.readAsset('views/serial/main.js')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('treats the declaration, not the declared surface, as the model presence', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    const instance = harnessed.instances.get(INSTANCE_ID);
    if (instance === undefined) throw new Error('no instance');
    harnessed.instances.set(INSTANCE_ID, { ...instance, hasModel: false });
    needRegistry(harnessed, await fixture());
    const opened = await harnessed.open();
    expect(opened.message.target.hasModel).toBe(false);
    const author = (await opened.author()).proxy;
    expect(wireCode(await rejectionOf(() => author.callModel('getOn', null)))).toBe(
      'view/unavailable-mode',
    );
    expect(wireCode(await rejectionOf(() => author.subscribe('onDidChange')))).toBe(
      'view/unavailable-mode',
    );
  });

  it('fails the open when a declared model has no proxy instead of hiding it', async () => {
    const harnessed = harness({ withoutModel: true });
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const error = await rejectionOf(() =>
      harnessed.host.open({ instanceId: INSTANCE_ID, viewId: 'serial', location: 'sidebar' }),
    );
    expect((error as { readonly code?: unknown }).code).toBe('view/unavailable-mode');
    expect((error as Error).message).toContain('has no model source');
    expect(harnessed.created).toHaveLength(0);
  });

  it('propagates a runtime model failure as an unavailable mode', async () => {
    const harnessed = harness({
      modelSource: () => {
        throw Object.assign(
          new Error('No model is mounted: the fused runtime is not in run mode.'),
          { code: 'model/disconnected' },
        );
      },
    });
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const error = await rejectionOf(() =>
      harnessed.host.open({ instanceId: INSTANCE_ID, viewId: 'serial', location: 'sidebar' }),
    );
    expect((error as { readonly code?: unknown }).code).toBe('view/unavailable-mode');
    expect((error as Error).message).toContain('model/disconnected');
    expect(harnessed.created).toHaveLength(0);
  });

  it('propagates a failing declaration callback instead of reporting "not mounted"', async () => {
    const harnessed = harness({ describeThrows: new Error('device map exploded') });
    pending.push(harnessed.dispose);
    const error = await rejectionOf(() =>
      harnessed.host.open({ instanceId: INSTANCE_ID, viewId: 'serial', location: 'sidebar' }),
    );
    expect((error as Error).message).toBe('device map exploded');
  });
  it('cancels a pending open on close before any record or frame exists', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    const data = await fixture();
    usePackage(harnessed, data);
    const gate = delayedRegistry(harnessed, data);
    const opening = harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'sidebar',
    });
    await settle();
    expect(harnessed.created).toHaveLength(0);

    expect(harnessed.host.close(INSTANCE_ID, 'serial')).toBe(true);
    expect(await codeOf(() => opening)).toBe('view/unavailable-mode');
    expect(await codeOf(() => opening)).toBe('view/unavailable-mode');

    gate.open();
    await settle(20);
    expect(harnessed.host.get(INSTANCE_ID, 'serial')).toBeUndefined();
    expect(harnessed.host.views).toEqual([]);
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(0);
    expect(harnessed.failures).toEqual([]);
  });

  it('cancels pending opens on closeAll and keeps the manager usable', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    const data = await fixture();
    usePackage(harnessed, data);
    const gate = delayedRegistry(harnessed, data);
    const opening = harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'sidebar',
    });
    await settle();

    harnessed.host.closeAll();
    expect(await codeOf(() => opening)).toBe('view/unavailable-mode');
    gate.open();
    await settle(20);
    expect(harnessed.host.views).toEqual([]);
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(0);

    harnessed.setRegistry(data.registry);
    const reopened = await harnessed.open('serial');
    expect(reopened.handle.state).toBe('loading');
    expect(harnessed.host.get(INSTANCE_ID, 'serial')).toBe(reopened.handle);
  });

  it('cancels a pending open on dispose', async () => {
    const harnessed = harness();
    const data = await fixture();
    usePackage(harnessed, data);
    const gate = delayedRegistry(harnessed, data);
    const opening = harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'sidebar',
    });
    await settle();

    await harnessed.host.dispose();
    expect(await codeOf(() => opening)).toBe('view/unavailable-mode');
    gate.open();
    await settle(20);
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(0);
    expect(
      await codeOf(() =>
        harnessed.host.open({
          instanceId: INSTANCE_ID,
          viewId: 'serial',
          location: 'sidebar',
        }),
      ),
    ).toBe('view/unavailable-mode');
  });

  it('does not reuse a cancelled pending open for the next request', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    const data = await fixture();
    usePackage(harnessed, data);
    const gate = delayedRegistry(harnessed, data);
    const first = harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'sidebar',
    });
    await settle();
    expect(harnessed.host.close(INSTANCE_ID, 'serial')).toBe(true);

    const second = harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'sidebar',
    });
    gate.open();
    await settle(20);
    expect(await codeOf(() => first)).toBe('view/unavailable-mode');
    const handle = await second;
    expect(handle.state).toBe('loading');
    expect(harnessed.created.filter((element) => element.tagName === 'iframe')).toHaveLength(1);
  });
  it('reports a handshake failure when the frame has no window', async () => {
    const harnessed = harness();
    pending.push(harnessed.dispose);
    needRegistry(harnessed, await fixture());
    const handle = await harnessed.host.open({
      instanceId: INSTANCE_ID,
      viewId: 'serial',
      location: 'sidebar',
    });
    const frame = harnessed.created.filter((element) => element.tagName === 'iframe').at(-1);
    if (frame === undefined) throw new Error('no frame');
    frame.contentWindow = null;
    frame.dispatch('load');
    expect(handle.state).toBe('failed');
    expect(handle.failure?.code).toBe('view/bridge-failed');
  });
});

function needRegistry(harnessed: IHarness, data: IFixture): void {
  usePackage(harnessed, data);
}

/** Resolves once one endpoint closed; a lane that already closed resolves immediately. */
function closedOf(endpoint: RpcEndpoint): Promise<void> {
  return new Promise<void>((resolve) => {
    endpoint.onDidClose(() => resolve());
  });
}

function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error,
  );
}

function settle(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Holds the verified package read until the test opens the gate. */
function delayedRegistry(harnessed: IHarness, data: IFixture): { open(): void } {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  harnessed.setRegistry({
    open: async (lock) => {
      await blocked;
      return data.registry.open(lock);
    },
  });
  return {
    open() {
      release?.();
      release = undefined;
    },
  };
}

interface IFakeModel {
  readonly client: IFusedModelClient;
  readonly calls: Array<{ readonly method: string; readonly params: Value }>;
  fire(value: Value): void;
}

function fakeModel(): IFakeModel {
  const calls: IFakeModel['calls'] = [];
  const changes = new Emitter<ModelEvent<Value>>();
  let sequence = 0;
  const client: IFusedModelClient = {
    methods: {
      getOn: async (params: Value) => {
        calls.push({ method: 'getOn', params });
        return true;
      },
      setOn: async (params: Value) => {
        calls.push({ method: 'setOn', params });
        return null;
      },
    },
    events: { onDidChange: changes.event },
  };
  return {
    client,
    calls,
    fire(value) {
      sequence += 1;
      changes.fire({ value, simTime: timePs(0), sequence });
    },
  };
}
