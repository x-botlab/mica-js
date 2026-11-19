import { timePs } from '@mica-js/core';
import { createRpc } from '@mica-js/core/rpc';
import type { Value } from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';
import { describe, expect, it } from 'vitest';
import { toWireFailure } from '../runtime/wire';
import { createDeviceViewSession } from './client';
import type { IDeviceViewSession } from './client';
import { HtmlViewError, fusedHtmlHostService } from './protocol';
import type { IFusedHtmlHostService, IFusedHtmlModelEventWire, IHtmlViewTarget } from './protocol';

const TARGET: IHtmlViewTarget = {
  instanceId: 'instance-1',
  viewId: 'serial',
  device: 'test:lamp',
  title: 'Serial',
  entry: 'views/serial/index.html',
  assetRoot: 'https://mica-1.cdn.example.com/p/__mica_view__/__mica_package__/',
  props: { label: 'lamp', level: 3 },
  methods: ['setOn', 'getOn'],
  events: ['onDidChange'],
  hasModel: true,
};

interface IHarness {
  readonly session: IDeviceViewSession;
  readonly calls: Array<{ readonly method: string; readonly params: Value }>;
  readonly subscriptions: string[];
  readonly reads: string[];
  readonly failures: Array<{ readonly code: string; readonly message: string }>;
  readonly closeListeners: Set<() => void>;
  readonly pushed: Set<(event: IFusedHtmlModelEventWire) => void>;
  fire(event: IFusedHtmlModelEventWire): Promise<void>;
  dispose(): void;
}

function harness(
  overrides: Partial<IHtmlViewTarget> = {},
  files: ReadonlyMap<string, Uint8Array> = new Map(),
): IHarness {
  const target: IHtmlViewTarget = { ...TARGET, ...overrides };
  const channel = new MessageChannel();
  const calls: IHarness['calls'] = [];
  const subscriptions: string[] = [];
  const reads: string[] = [];
  const failures: IHarness['failures'] = [];
  const pushed = new Set<(event: IFusedHtmlModelEventWire) => void>();
  const closeListeners = new Set<() => void>();
  const hostEndpoint = createRpc(channel.port1);
  const service: IFusedHtmlHostService = {
    async readAsset(path) {
      reads.push(path);
      const bytes = files.get(path);
      if (bytes === undefined) {
        throw toWireFailure(new HtmlViewError('view/load-failed', `Missing ${path}.`));
      }
      return bytes.slice();
    },
    async callModel(method, params) {
      calls.push({ method, params });
      if (method === 'setOn') return null;
      return true;
    },
    async subscribe(event) {
      subscriptions.push(`+${event}`);
    },
    async unsubscribe(event) {
      subscriptions.push(`-${event}`);
    },
    onDidModelEvent(listener) {
      pushed.add(listener);
      return () => pushed.delete(listener);
    },
    onDidClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    async reportFailure(code: string, message: string) {
      failures.push({ code, message });
    },
  };
  hostEndpoint.register(fusedHtmlHostService, service);
  const environmentEndpoint = createRpc(channel.port2);
  const host = environmentEndpoint.getProxy(fusedHtmlHostService);
  const session = createDeviceViewSession({
    host,
    target,
    reportFailure: (code: string, message: string) => failures.push({ code, message }),
    createObjectUrl: (blob) => `blob:test/${blob.type}`,
    revokeObjectUrl: (url) => failures.push({ code: 'revoked', message: url }),
  });
  host.onDidModelEvent((event) => session.deliver(event));
  host.onDidClose(() => session.close());
  return {
    session,
    calls,
    subscriptions,
    reads,
    failures,
    closeListeners,
    pushed,
    async fire(event) {
      for (const listener of pushed) listener(event);
      // The push crosses the port, so the environment observes it on a later task.
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    dispose() {
      session.dispose();
      hostEndpoint.dispose();
      environmentEndpoint.dispose();
    },
  };
}

function payload(value: Value): ModelEvent<Value> {
  return { value, simTime: timePs(0), sequence: 1 };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
}

function codeOf(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : `unexpected:${String(error)}`;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('createDeviceViewSession', () => {
  it('exposes the resolved props and the declared model surface', () => {
    const harnessed = harness();
    try {
      expect(harnessed.session.api.props).toEqual({ label: 'lamp', level: 3 });
      expect(Object.isFrozen(harnessed.session.api)).toBe(true);
      expect(harnessed.session.api.model?.methods['setOn']).toBeTypeOf('function');
      expect(harnessed.session.api.model?.methods['nope']).toBeUndefined();
    } finally {
      harnessed.dispose();
    }
  });

  it('forwards declared method calls with their parameters', async () => {
    const harnessed = harness();
    try {
      const model = harnessed.session.api.model;
      if (model === undefined) throw new Error('expected a model');
      await expect(model.methods['setOn']?.(true)).resolves.toBeNull();
      await expect(model.methods['getOn']?.(null)).resolves.toBe(true);
      expect(harnessed.calls).toEqual([
        { method: 'setOn', params: true },
        { method: 'getOn', params: null },
      ]);
    } finally {
      harnessed.dispose();
    }
  });

  it('subscribes once per event and delivers pushed payloads', async () => {
    const harnessed = harness();
    try {
      const events = harnessed.session.api.model?.events;
      if (events === undefined) throw new Error('expected event outlets');
      const first: Value[] = [];
      const second: Value[] = [];
      const one = events['onDidChange']?.((event) => first.push(event.value));
      const two = events['onDidChange']?.((event) => second.push(event.value));
      await waitFor(() => harnessed.subscriptions.length === 1);
      await waitFor(() => harnessed.pushed.size === 1);
      await harnessed.fire({ name: 'onDidChange', payload: payload(7) });
      expect(first).toEqual([7]);
      expect(second).toEqual([7]);
      one?.dispose();
      await harnessed.fire({ name: 'onDidChange', payload: payload(8) });
      expect(first).toEqual([7]);
      expect(second).toEqual([7, 8]);
      expect(harnessed.subscriptions).toEqual(['+onDidChange']);
      two?.dispose();
      await waitFor(() => harnessed.subscriptions.length === 2);
      expect(harnessed.subscriptions).toEqual(['+onDidChange', '-onDidChange']);
      await harnessed.fire({ name: 'onDidChange', payload: payload(9) });
      expect(second).toEqual([7, 8]);
    } finally {
      harnessed.dispose();
    }
  });

  it('reads declared package files and rejects invalid paths before the wire', async () => {
    const files = new Map([['views/serial/main.js', new Uint8Array([1, 2, 3])]]);
    const harnessed = harness({}, files);
    try {
      await expect(harnessed.session.api.assets.read('views/serial/main.js')).resolves.toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(
        codeOf(await rejectionOf(() => harnessed.session.api.assets.read('../escape.js'))),
      ).toBe('view/load-failed');
      expect(
        codeOf(
          await rejectionOf(() => harnessed.session.api.assets.read('views/serial/missing.js')),
        ),
      ).toBe('view/load-failed');
      expect(harnessed.reads).toEqual(['views/serial/main.js', 'views/serial/missing.js']);
    } finally {
      harnessed.dispose();
    }
  });

  it('resolves package URLs and revokes them when the view closes', async () => {
    const files = new Map([['board.webp', new Uint8Array([9])]]);
    const harnessed = harness({}, files);
    try {
      const url = await harnessed.session.api.assets.getUrl('board.webp');
      expect(url).toBe('blob:test/image/webp');
      harnessed.session.close();
      expect(harnessed.failures).toContainEqual({ code: 'revoked', message: url });
      expect(harnessed.session.closed).toBe(true);
    } finally {
      harnessed.dispose();
    }
  });

  it('fires onDidClose once when the editor closes the view', async () => {
    const harnessed = harness();
    try {
      const closed: number[] = [];
      harnessed.session.api.onDidClose(() => closed.push(1));
      await waitFor(() => harnessed.closeListeners.size === 1);
      for (const listener of harnessed.closeListeners) listener();
      await waitFor(() => closed.length === 1);
      expect(closed).toEqual([1]);
      harnessed.session.api.onDidClose(() => closed.push(2));
      expect(closed).toEqual([1, 2]);
    } finally {
      harnessed.dispose();
    }
  });

  it('reports a throwing author listener as one view execution failure', async () => {
    const harnessed = harness();
    try {
      const events = harnessed.session.api.model?.events;
      events?.['onDidChange']?.(() => {
        throw new Error('author exploded');
      });
      await waitFor(() => harnessed.pushed.size === 1);
      await harnessed.fire({ name: 'onDidChange', payload: payload(1) });
      await harnessed.fire({ name: 'onDidChange', payload: payload(2) });
      expect(harnessed.failures).toEqual([
        {
          code: 'view/execution-failed',
          message: 'Listener of "onDidChange" failed: author exploded',
        },
      ]);
    } finally {
      harnessed.dispose();
    }
  });

  it('leaves the model undefined for a device without one', () => {
    const harnessed = harness({ hasModel: false, methods: [], events: [] });
    try {
      expect(harnessed.session.api.model).toBeUndefined();
    } finally {
      harnessed.dispose();
    }
  });

  it('stops delivering events into a closed view', async () => {
    const harnessed = harness();
    try {
      const seen: Value[] = [];
      harnessed.session.api.model?.events['onDidChange']?.((event) => seen.push(event.value));
      await waitFor(() => harnessed.pushed.size === 1);
      harnessed.session.close();
      await harnessed.fire({ name: 'onDidChange', payload: payload(1) });
      expect(seen).toEqual([]);
    } finally {
      harnessed.dispose();
    }
  });
});
