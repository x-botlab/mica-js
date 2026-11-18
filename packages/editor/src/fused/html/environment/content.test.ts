import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HTML_VIEW_ATTACH,
  HTML_VIEW_ATTACH_ACK,
  HTML_VIEW_CHILD_CONNECT,
  HTML_VIEW_CHILD_HELLO,
  HTML_VIEW_CHILD_PREPARED,
  HTML_VIEW_FRAME_PARAM,
  fusedHtmlContentViewService,
  fusedHtmlHostService,
} from '../protocol';
import type { IFusedHtmlHostService, IHtmlViewContent } from '../protocol';
import { startHtmlViewContent } from './content';

const ENVIRONMENT_ORIGIN = 'https://mica-1.example.com';
const CONTENT_URL = `${ENVIRONMENT_ORIGIN}/p/__mica_view__/content.html`;
const FRAME_TOKEN = 'a'.repeat(32);
const GRANT_TOKEN = 'b'.repeat(32);

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.unstubAllGlobals();
});

/** One observed operation of the bootstrap, in the order it happened. */
type Step = 'hello' | 'connect' | 'prepared' | 'attach';

class FakeWorker {
  readonly postMessage = vi.fn((message: unknown, ports: readonly Transferable[] = []) => {
    const data = message as { readonly type?: string; readonly token?: string } | null;
    if (data === null || data.type !== HTML_VIEW_ATTACH) return;
    this.attachToken = data.token;
    this.steps.push('attach');
    const port = ports[0];
    if (port === undefined || !this.ack) return;
    queueMicrotask(() => {
      (port as MessagePort).postMessage({ type: HTML_VIEW_ATTACH_ACK, token: data.token });
    });
  });
  attachToken: string | undefined;
  ack = true;

  constructor(readonly steps: Step[]) {}
}

class FakeWindow {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly posted: Array<{ readonly message: unknown; readonly origin: string | undefined }> = [];
  /** A real same-origin content document, so its origin is concrete and comparable. */
  readonly location: URL;
  readonly parent: { postMessage: (message: unknown, origin?: string) => void };
  readonly navigator: { serviceWorker: { controller: FakeWorker } };
  readonly worker: FakeWorker;

  constructor(options: {
    readonly url?: string;
    readonly token?: string;
    readonly steps: Step[];
    readonly ack?: boolean;
  }) {
    const url = new URL(options.url ?? CONTENT_URL);
    if (options.token !== undefined) url.searchParams.set(HTML_VIEW_FRAME_PARAM, options.token);
    this.location = url;
    this.worker = new FakeWorker(options.steps);
    this.worker.ack = options.ack ?? true;
    this.navigator = { serviceWorker: { controller: this.worker } };
    this.parent = { postMessage: () => undefined };
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let entries = this.listeners.get(type);
    if (entries === undefined) this.listeners.set(type, (entries = new Set()));
    entries.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  deliver(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  connectFrame(port: MessagePort, origin = ENVIRONMENT_ORIGIN, steps?: Step[]): void {
    steps?.push('connect');
    this.deliver('message', {
      type: 'message',
      data: { type: HTML_VIEW_CHILD_CONNECT, token: FRAME_TOKEN },
      origin,
      source: this.parent,
      ports: [port],
    });
  }
}

interface IHarness {
  readonly started: Promise<void>;
  readonly window: FakeWindow;
  readonly failures: Array<{ readonly code: string; readonly message: string }>;
  readonly steps: Step[];
  /** Editor end of the author lane, including its view identity service. */
  readonly environment: RpcEndpoint;
  readonly port: MessagePort;
  /** Identity the frame window carried when the frame announced it may be written. */
  readonly preparedApi: Array<string>;
}

function harness(
  options: {
    readonly token?: string;
    readonly url?: string;
    readonly ack?: boolean;
    /** Holds the handshake until the test delivers the bridge answer itself. */
    readonly manual?: boolean;
  } = {},
): IHarness {
  const steps: Step[] = [];
  const failures: IHarness['failures'] = [];
  const preparedApi: string[] = [];
  const channel = new MessageChannel();
  const environment = createRpc(channel.port1);
  cleanup.push(() => environment.dispose());
  const host: IFusedHtmlHostService = {
    readAsset: async () => new Uint8Array(),
    callModel: async () => null,
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
    onDidModelEvent: () => () => undefined,
    onDidClose: () => () => undefined,
    reportFailure: async (code, message) => {
      failures.push({ code, message });
    },
  };
  environment.register(fusedHtmlHostService, host);
  const content: IHtmlViewContent = {
    token: GRANT_TOKEN,
    target: {
      instanceId: 'led-1',
      viewId: 'monitor',
      device: 'test:led',
      title: 'Monitor',
      entry: 'monitor/index.html',
      assetRoot: `${ENVIRONMENT_ORIGIN}/p/__mica_view__/__mica_package__/`,
      props: {},
      methods: [],
      events: [],
      hasModel: false,
    },
  };
  const win = new FakeWindow({
    steps,
    ack: options.ack ?? true,
    ...(options.token === undefined ? { token: FRAME_TOKEN } : { token: options.token }),
    ...(options.url === undefined ? {} : { url: options.url }),
  });
  environment.register(fusedHtmlContentViewService, { view: async () => content });
  // The environment only hands the author port on; the frame announces its own readiness.
  win.parent.postMessage = (message: unknown, origin?: string) => {
    win.posted.push({ message, origin });
    const data = message as { readonly type?: string } | null;
    if (data === null || typeof data.type !== 'string') return;
    if (data.type === HTML_VIEW_CHILD_HELLO) {
      steps.push('hello');
      if (options.manual === true) return;
      win.connectFrame(channel.port2, ENVIRONMENT_ORIGIN, steps);
      return;
    }
    if (data.type !== HTML_VIEW_CHILD_PREPARED) return;
    steps.push('prepared');
    // The environment writes the author document now, so the bridge must already exist.
    preparedApi.push(
      typeof (win as unknown as { acquireDeviceViewApi?: unknown })?.acquireDeviceViewApi,
    );
  };
  vi.stubGlobal('window', win);
  const started = startHtmlViewContent({ connectTimeoutMs: 50, attachTimeoutMs: 50 });
  return { started, window: win, failures, steps, environment, port: channel.port2, preparedApi };
}

describe('HTML view content bootstrap', () => {
  it('authorizes the frame before it announces that the environment may write', async () => {
    const run = harness();
    await run.started;
    expect(run.steps).toEqual(['hello', 'connect', 'attach', 'prepared']);
    expect(run.window.worker.attachToken).toBe(GRANT_TOKEN);
    expect(run.failures).toEqual([]);
  });

  it('installs acquireDeviceViewApi before the environment writes the document', async () => {
    const run = harness();
    await run.started;
    expect(run.preparedApi).toEqual(['function']);
    // The bridge entry is one-time and cannot be replaced by author code.
    expect(() =>
      Object.defineProperty(run.window, 'acquireDeviceViewApi', { value: () => undefined }),
    ).toThrow();
  });

  it('posts the handshake and the readiness announcement to the concrete environment origin', async () => {
    const run = harness();
    await run.started;
    expect(run.window.location.origin).toBe(ENVIRONMENT_ORIGIN);
    expect(run.window.posted.map((entry) => entry.origin)).toEqual([
      ENVIRONMENT_ORIGIN,
      ENVIRONMENT_ORIGIN,
    ]);
    // The readiness announcement carries no host capability, only the frame token.
    expect(run.window.posted.at(-1)?.message).toEqual({
      type: HTML_VIEW_CHILD_PREPARED,
      token: FRAME_TOKEN,
    });
  });

  it('ignores a bridge answer from a foreign or opaque origin and accepts the environment', async () => {
    const run = harness({ manual: true });
    run.window.connectFrame(run.port, 'https://evil.example.com');
    run.window.connectFrame(run.port, 'null');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run.steps).toEqual(['hello']);
    run.window.connectFrame(run.port, ENVIRONMENT_ORIGIN, run.steps);
    await run.started;
    expect(run.steps).toEqual(['hello', 'connect', 'attach', 'prepared']);
    expect(run.failures).toEqual([]);
  });

  it('never announces a prepared frame when the worker does not authorize it', async () => {
    const run = harness({ ack: false });
    await expect(run.started).rejects.toThrow('did not authorize');
    expect(run.steps).toEqual(['hello', 'connect', 'attach']);
    await vi.waitFor(() =>
      expect(run.failures).toEqual([
        {
          code: 'view/load-failed',
          message: 'The package asset worker did not authorize the view.',
        },
      ]),
    );
  });

  it('fails explicitly when the frame URL carries no view token', async () => {
    const run = harness({ token: '' });
    await expect(run.started).rejects.toThrow('carries no view token');
    expect(run.steps).toEqual([]);
    expect(run.window.worker.postMessage).not.toHaveBeenCalled();
    expect(run.window.posted).toEqual([]);
  });

  it('fails explicitly when the frame has no concrete origin', async () => {
    for (const url of ['about:srcdoc', 'about:blank', 'blob:https://mica-1.example.com/x']) {
      const run = harness({ url });
      await expect(run.started).rejects.toThrow('no concrete environment origin');
      expect(run.steps).toEqual([]);
      expect(run.window.posted).toEqual([]);
    }
  });

  it('leaves the author error lane to the environment, which owns the document open', async () => {
    const run = harness();
    await run.started;
    // The open that writes the author document clears window listeners, so the inner bootstrap
    // never installs them; the environment installs them after its own open.
    expect([...run.window.listeners.keys()].sort()).toEqual(['message']);
    run.window.deliver('error', { message: 'author exploded' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(run.failures).toEqual([]);
  });
});
