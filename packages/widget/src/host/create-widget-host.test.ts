import { describe, expect, it } from 'vitest';
import { createStaticWidgetProvider } from '../provider/static';
import { WIDGET_ERROR_EVENT, WIDGET_FRAME_EVENT, WIDGET_PUBLISH_EVENT } from '../runtime/protocol';
import type { WidgetModule } from '../types';
import { createWidgetHost } from './create-widget-host';
import type { WidgetDiagnostic, WidgetLayerChange, WidgetPublish, WidgetSandbox } from './types';

interface FakeBitmap {
  readonly instanceId: string;
  closed: boolean;
  close(): void;
}

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

class FakeSandbox implements WidgetSandbox {
  state: 'ready' | 'terminated' = 'ready';
  readonly calls: RecordedCall[] = [];
  readonly reasons: string[] = [];
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #failures = new Map<string, Error[]>();

  fail(method: string, error: Error): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(error);
    this.#failures.set(method, queue);
  }

  call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    const failure = this.#failures.get(method)?.shift();
    return failure ? Promise.reject(failure) : Promise.resolve(undefined);
  }

  on(type: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => {
      this.#listeners.get(type)?.delete(listener);
    };
  }

  terminate(reason?: string): Promise<void> {
    this.reasons.push(reason ?? '');
    this.state = 'terminated';
    return Promise.resolve();
  }

  emit(type: string, payload: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(payload);
    }
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  argsOf(method: string): readonly unknown[] | undefined {
    return this.calls.find((call) => call.method === method)?.args;
  }
}

function createBitmap(instanceId: string): FakeBitmap {
  const bitmap: FakeBitmap = {
    instanceId,
    closed: false,
    close: () => {
      bitmap.closed = true;
    },
  };
  return bitmap;
}

const asBitmap = (bitmap: FakeBitmap): ImageBitmap => bitmap as unknown as ImageBitmap;

const demoModule: WidgetModule = {
  definition: { properties: {}, ports: {} },
  code: 'export default () => ({});',
};

const provider = createStaticWidgetProvider({ 'demo:indicator': demoModule });

interface Harness {
  readonly host: ReturnType<typeof createWidgetHost>;
  readonly sandbox: FakeSandbox;
  readonly diagnostics: WidgetDiagnostic[];
  readonly changes: WidgetLayerChange[];
  readonly publishes: WidgetPublish[];
  readonly starts: () => number;
}

function createHarness(sandbox = new FakeSandbox()): Harness {
  const diagnostics: WidgetDiagnostic[] = [];
  const changes: WidgetLayerChange[] = [];
  const publishes: WidgetPublish[] = [];
  let starts = 0;

  const host = createWidgetHost({
    provider,
    sandbox: () => {
      starts += 1;
      return Promise.resolve(sandbox);
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onPublish: (publish) => publishes.push(publish),
  });
  host.layers.subscribe((change) => changes.push(change));

  return { host, sandbox, diagnostics, changes, publishes, starts: () => starts };
}

function mount(host: Harness['host'], overrides: Record<string, unknown> = {}): Promise<void> {
  return host.mount({
    instanceId: 'a',
    widget: 'demo:indicator',
    width: 20,
    height: 10,
    ...overrides,
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createWidgetHost', () => {
  it('does not start the sandbox until the first mount', async () => {
    const harness = createHarness();

    expect(harness.starts()).toBe(0);
    await mount(harness.host);

    expect(harness.starts()).toBe(1);
  });

  it('starts one sandbox for two instances and keeps mount order', async () => {
    const harness = createHarness();

    await mount(harness.host);
    await mount(harness.host, { instanceId: 'b' });

    expect(harness.starts()).toBe(1);
    expect(harness.host.layers.list().map((layer) => layer.instanceId)).toEqual(['a', 'b']);
    expect(harness.sandbox.methods().filter((method) => method === 'mount')).toHaveLength(2);
    expect(harness.changes).toEqual([
      { type: 'added', instanceId: 'a' },
      { type: 'added', instanceId: 'b' },
    ]);
  });

  it('sends the resolved module to the guest before mounting', async () => {
    const harness = createHarness();

    await mount(harness.host);

    expect(harness.sandbox.methods().slice(0, 2)).toEqual(['load', 'mount']);
    expect(harness.sandbox.argsOf('load')).toEqual([
      {
        packages: [
          {
            id: 'demo',
            modules: { indicator: { definition: demoModule.definition, code: demoModule.code } },
          },
        ],
      },
    ]);
    expect(harness.sandbox.argsOf('mount')).toEqual([
      { instanceId: 'a', widget: 'demo:indicator', width: 20, height: 10, dpr: 1, props: {} },
    ]);
  });

  it('applies geometry synchronously without touching the frame sequence', async () => {
    const harness = createHarness();
    await mount(harness.host);

    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'a',
      bitmap: asBitmap(createBitmap('a')),
      width: 20,
      height: 10,
      dpr: 1,
    });
    const layer = harness.host.layers.get('a');
    expect(layer?.sequence).toBe(1);

    harness.host.update('a', { width: 60, height: 30 });
    expect(layer?.width).toBe(60);
    expect(layer?.height).toBe(30);
    expect(layer?.sequence).toBe(1);

    await tick();
    expect(harness.sandbox.argsOf('resize')).toEqual(['a', 60, 30, 1]);
  });

  it('installs frames, increments the sequence and closes the previous bitmap', async () => {
    const harness = createHarness();
    await mount(harness.host);
    const first = createBitmap('a');
    const second = createBitmap('a');

    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'a',
      bitmap: asBitmap(first),
      width: 20,
      height: 10,
      dpr: 1,
    });
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'a',
      bitmap: asBitmap(second),
      width: 20,
      height: 10,
      dpr: 1,
    });

    const layer = harness.host.layers.get('a');
    expect(layer?.sequence).toBe(2);
    expect(layer?.bitmap).toBe(asBitmap(second));
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(harness.changes).toEqual([
      { type: 'added', instanceId: 'a' },
      { type: 'updated', instanceId: 'a' },
      { type: 'updated', instanceId: 'a' },
    ]);
  });

  it('closes frames that arrive for an instance that is gone', async () => {
    const harness = createHarness();
    await mount(harness.host);
    const bitmap = createBitmap('unknown');

    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'unknown',
      bitmap: asBitmap(bitmap),
      width: 1,
      height: 1,
      dpr: 1,
    });

    expect(bitmap.closed).toBe(true);
    expect(harness.host.layers.get('unknown')).toBeUndefined();
  });

  it('forwards properties without producing frames on its own', async () => {
    const harness = createHarness();
    await mount(harness.host);

    harness.host.setProperties('a', { color: 'red' });
    await tick();

    const layer = harness.host.layers.get('a');
    expect(layer?.sequence).toBe(0);
    expect(layer?.bitmap).toBeUndefined();
    expect(harness.sandbox.argsOf('set-properties')).toEqual(['a', { color: 'red' }]);
  });

  it('keeps every other instance when one reports a failure', async () => {
    const harness = createHarness();
    await mount(harness.host);
    await mount(harness.host, { instanceId: 'b' });

    harness.sandbox.emit(WIDGET_ERROR_EVENT, {
      instanceId: 'a',
      phase: 'render',
      error: { name: 'Error', message: 'bad frame' },
    });

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({
        code: 'widget/render-failed',
        instanceId: 'a',
        widget: 'demo:indicator',
      }),
    ]);
    expect(harness.host.layers.get('a')).toBeDefined();
    expect(harness.host.layers.get('b')).toBeDefined();
  });

  it('reports delivery failures without dropping the instance', async () => {
    const harness = createHarness();
    await mount(harness.host);

    harness.sandbox.emit(WIDGET_ERROR_EVENT, {
      instanceId: 'a',
      phase: 'deliver',
      error: { name: 'TypeError', message: 'listener exploded' },
    });

    expect(harness.diagnostics[0]).toMatchObject({
      code: 'widget/deliver-failed',
      instanceId: 'a',
    });
    expect(harness.host.layers.get('a')).toBeDefined();
  });

  it('forwards published payloads to the host callback', async () => {
    const harness = createHarness();
    await mount(harness.host);

    harness.sandbox.emit(WIDGET_PUBLISH_EVENT, {
      instanceId: 'a',
      port: 'value',
      payload: 3,
    });

    expect(harness.publishes).toEqual([{ instanceId: 'a', port: 'value', payload: 3 }]);
  });

  it('removes the layer and closes its bitmap on unmount', async () => {
    const harness = createHarness();
    await mount(harness.host);
    const bitmap = createBitmap('a');
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'a',
      bitmap: asBitmap(bitmap),
      width: 20,
      height: 10,
      dpr: 1,
    });

    harness.host.unmount('a');

    expect(harness.host.layers.get('a')).toBeUndefined();
    expect(bitmap.closed).toBe(true);
    expect(harness.changes.at(-1)).toEqual({ type: 'removed', instanceId: 'a' });

    await tick();
    expect(harness.sandbox.argsOf('unmount')).toEqual(['a']);
  });

  it('terminates the sandbox and closes every bitmap on dispose', async () => {
    const harness = createHarness();
    await mount(harness.host);
    const bitmap = createBitmap('a');
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'a',
      bitmap: asBitmap(bitmap),
      width: 20,
      height: 10,
      dpr: 1,
    });

    await harness.host.dispose();
    await harness.host.dispose();

    expect(harness.sandbox.reasons).toHaveLength(1);
    expect(bitmap.closed).toBe(true);
    expect(harness.host.layers.list()).toEqual([]);
  });

  it('reports duplicate instances without touching the mounted one', async () => {
    const harness = createHarness();
    await mount(harness.host);

    await mount(harness.host);

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/instance-exists', instanceId: 'a' }),
    ]);
    expect(harness.sandbox.methods().filter((method) => method === 'mount')).toHaveLength(1);
  });

  it('reports missing instances for every instance-scoped method', async () => {
    const harness = createHarness();

    harness.host.update('ghost', { width: 1, height: 1 });
    harness.host.setProperties('ghost', {});
    harness.host.deliver('ghost', 'value', 1, 0);
    harness.host.dispatch('ghost', { type: 'pointerdown' });
    harness.host.unmount('ghost');

    expect(harness.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'widget/instance-not-found',
      'widget/instance-not-found',
      'widget/instance-not-found',
      'widget/instance-not-found',
      'widget/instance-not-found',
    ]);
    expect(harness.starts()).toBe(0);
  });

  it('reports widgets the provider does not know', async () => {
    const harness = createHarness();

    await mount(harness.host, { widget: 'demo:missing' });

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/unknown-widget', widget: 'demo:missing' }),
    ]);
    expect(harness.host.layers.list()).toEqual([]);
    expect(harness.starts()).toBe(0);
  });

  it('rejects and drops the layer when the guest cannot mount the widget', async () => {
    const harness = createHarness();
    harness.sandbox.fail('mount', new Error('factory exploded'));

    await expect(mount(harness.host)).rejects.toThrow('factory exploded');

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/mount-failed', instanceId: 'a' }),
    ]);
    expect(harness.host.layers.list()).toEqual([]);
  });

  it('clears layers and reports one runtime failure when the sandbox terminates', async () => {
    const harness = createHarness();
    await mount(harness.host);
    const bitmap = createBitmap('a');
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'a',
      bitmap: asBitmap(bitmap),
      width: 20,
      height: 10,
      dpr: 1,
    });

    harness.sandbox.state = 'terminated';
    harness.host.deliver('a', 'brightness', 1, 0);
    await tick();

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/runtime-failed' }),
    ]);
    expect(harness.host.layers.list()).toEqual([]);
    expect(bitmap.closed).toBe(true);
  });

  it('repaints every layer when the device pixel ratio changes', async () => {
    const harness = createHarness();
    await mount(harness.host);

    harness.host.resize(2);

    expect(harness.host.layers.get('a')?.dpr).toBe(2);
    await tick();
    expect(harness.sandbox.argsOf('resize')).toEqual(['a', 20, 10, 2]);
  });

  it('reports a runtime failure when the sandbox cannot start', async () => {
    const diagnostics: WidgetDiagnostic[] = [];
    const host = createWidgetHost({
      provider,
      sandbox: () => Promise.reject(new Error('no iframe')),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(mount(host)).rejects.toThrow('no iframe');

    expect(diagnostics).toEqual([expect.objectContaining({ code: 'widget/runtime-failed' })]);
    expect(host.layers.list()).toEqual([]);
  });

  it('terminates a sandbox that finishes starting after dispose', async () => {
    const sandbox = new FakeSandbox();
    let resolveStart: ((value: WidgetSandbox) => void) | undefined;
    const host = createWidgetHost({
      provider,
      sandbox: () =>
        new Promise<WidgetSandbox>((resolve) => {
          resolveStart = resolve;
        }),
    });

    const mounting = mount(host);
    await tick();
    const disposing = host.dispose();
    resolveStart?.(sandbox);

    await expect(mounting).rejects.toThrow('disposed');
    await disposing;

    expect(sandbox.reasons).toHaveLength(1);
    expect(host.layers.list()).toEqual([]);
  });
});
