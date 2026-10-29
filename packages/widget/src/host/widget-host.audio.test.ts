import type { CanvasDocument, CanvasWidgetInstance } from '@mica-js/core/canvas';
import { afterEach, describe, expect, it } from 'vitest';
import { toDisposable } from '@mica-js/core/lifecycle';
import { createStaticWidgetProvider } from '../package/static-provider';

import type { WidgetModule } from '../types';
import type { WidgetDiagnostic, WidgetSandbox, WidgetSandboxAudio } from './types';
import { createWidgetHost } from './widget-host';
import type { DeviceSimulationHost } from '@mica-js/simulator';
import { createWidgetAudioRuntime } from '../guest/audio/controller';
import type { WidgetAudioRuntime } from '../guest/audio/controller';
import type { WidgetAudioMountInfo, WidgetAudioState } from '../guest/audio/protocol';
import { createWorkletNode, FakeAudioContext, flush } from './audio/test-helpers';
import type { WorkletNodeHarness } from './audio/test-helpers';

class FakeSandbox implements WidgetSandbox {
  state: 'ready' | 'terminated' = 'ready';
  readonly calls: { method: string; args: readonly unknown[] }[] = [];
  readonly emitted: { type: string; payload: unknown; transfer: readonly Transferable[] }[] = [];
  readonly states: WidgetAudioState[] = [];
  port: MessagePort | undefined;
  readonly audio: WidgetSandboxAudio = {
    attachPort: (port) => {
      this.port = port;
    },
    setState: (state) => {
      this.states.push(state);
    },
  };
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();

  call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    return Promise.resolve(undefined);
  }

  on(type: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string, payload?: unknown, transfer?: readonly Transferable[]): void {
    this.emitted.push({ type, payload, transfer: transfer ?? [] });
  }

  terminate(): Promise<void> {
    this.state = 'terminated';
    return Promise.resolve();
  }

  argsOf(method: string): readonly unknown[] | undefined {
    return this.calls.find((call) => call.method === method)?.args;
  }
}

const demoModule: WidgetModule = {
  definition: { properties: {}, ports: {} },
  code: 'export default () => ({});',
};

const provider = createStaticWidgetProvider({ 'demo:indicator': demoModule });

/** The host requires a device host (RFC 0018); the audio tests never touch the runtime. */
const idleDeviceHost: DeviceSimulationHost = {
  async loadSchematic() {},
  async reset() {},
  async tick(dt: number) {
    return { simTime: dt, executed: 1 };
  },
  async deliver() {},
  onDidPublish: () => toDisposable(() => {}),
  async getTopics() {
    return [];
  },
  async getSimTime() {
    return 0;
  },
  async getSchematic() {
    return undefined;
  },
  async dispose() {},
};

function instance(): CanvasWidgetInstance {
  return {
    id: '0f1d5a70-0000-4000-8000-0000000000aa',
    widget: 'demo:indicator',
    x: 0,
    y: 0,
    width: 20,
    height: 10,
    rotation: 0,
  };
}

function canvas(): CanvasDocument {
  return { version: 1, widgets: [instance()] };
}

const globals = globalThis as { AudioWorkletNode?: unknown };
const originalWorkletNode = globals.AudioWorkletNode;
let installed: WorkletNodeHarness | undefined;

afterEach(() => {
  globals.AudioWorkletNode = originalWorkletNode;
  installed?.dispose();
  installed = undefined;
});

/** The engine builds the worklet node from the global constructor, like a browser would. */
function installWorklet(harness: WorkletNodeHarness): void {
  installed = harness;
  globals.AudioWorkletNode = class {
    readonly port = harness.node.port;
    connect(): void {}
    disconnect(): void {}
  };
}

interface HostHarness {
  readonly host: ReturnType<typeof createWidgetHost>;
  readonly sandbox: FakeSandbox;
  readonly context: FakeAudioContext;
  readonly diagnostics: WidgetDiagnostic[];
  /** Attaches a real guest runtime to the port the host handed the sandbox. */
  mountGuest(info: WidgetAudioMountInfo, instanceId?: string): WidgetAudioRuntime;
}

function createHarness(
  options: { audio?: boolean; state?: string; maxStreams?: number } = {},
): HostHarness {
  const sandbox = new FakeSandbox();
  const context = new FakeAudioContext(options.state === undefined ? {} : { state: options.state });
  const diagnostics: WidgetDiagnostic[] = [];
  const host = createWidgetHost(
    {
      provider,
      deviceHost: idleDeviceHost,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      ...(options.audio === false
        ? {}
        : {
            audio: {
              context: context as unknown as AudioContext,
              ...(options.maxStreams === undefined
                ? {}
                : { limits: { maxStreams: options.maxStreams } }),
            },
          }),
    },
    async () => sandbox,
  );
  return {
    host,
    sandbox,
    context,
    diagnostics,
    mountGuest(info, instanceId = instance().id) {
      const runtime = createWidgetAudioRuntime({});
      if (sandbox.port !== undefined) runtime.attachPort(sandbox.port);
      runtime.open(instanceId, info);
      return runtime;
    },
  };
}

const ID = instance().id;

describe('WidgetHost audio wiring', () => {
  it('mounts with the worklet session and transfers the direct port', async () => {
    const worklet = createWorkletNode();
    installWorklet(worklet);
    const { host, sandbox } = createHarness();

    await host.loadDocument(canvas());

    const mount = sandbox.argsOf('mount')?.[0] as { audio?: WidgetAudioMountInfo };
    expect(mount.audio?.state).toBe('running');
    expect(mount.audio?.session).toEqual(expect.any(String));
    expect(sandbox.port).toBeDefined();
    expect(host.audio.state).toBe('running');

    await host.dispose();
  });

  it('plays a tone the guest creates over its own port', async () => {
    const worklet = createWorkletNode();
    installWorklet(worklet);
    const { host, sandbox, mountGuest } = createHarness();
    await host.loadDocument(canvas());
    const mount = sandbox.argsOf('mount')?.[0] as { audio: WidgetAudioMountInfo };

    const runtime = mountGuest(mount.audio);
    runtime.api(ID).tone({ type: 'square', frequency: 480, volume: 1 });
    await flush();

    expect(Math.max(...worklet.render(128).left.map(Math.abs))).toBeGreaterThan(0.5);
    runtime.dispose();
    await host.dispose();
  });

  it('pushes availability changes into the guest', async () => {
    const worklet = createWorkletNode();
    installWorklet(worklet);
    const { host, sandbox } = createHarness();
    await host.loadDocument(canvas());

    host.audio.suspend();
    expect(sandbox.states.at(-1)).toBe('suspended');

    host.audio.resume();
    expect(sandbox.states.at(-1)).toBe('running');

    await host.dispose();
  });

  it('revokes the session on unmount', async () => {
    const worklet = createWorkletNode();
    installWorklet(worklet);
    const { host, sandbox, mountGuest } = createHarness();
    await host.loadDocument(canvas());
    const mount = sandbox.argsOf('mount')?.[0] as { audio: WidgetAudioMountInfo };

    const runtime = mountGuest(mount.audio);
    const stream = runtime.api(ID).createStream({ sampleRate: 48000 });
    await flush();

    await host.loadDocument({ version: 1, widgets: [] });
    await expect(stream.ended).resolves.toEqual({ reason: 'stopped' });

    runtime.dispose();
    await host.dispose();
  });

  it('tags a suspended context in the mount request', async () => {
    const worklet = createWorkletNode();
    installWorklet(worklet);
    const { host, sandbox } = createHarness({ state: 'suspended' });
    await host.loadDocument(canvas());

    const mount = sandbox.argsOf('mount')?.[0] as { audio?: WidgetAudioMountInfo };
    expect(mount.audio?.state).toBe('suspended');
    expect(host.audio.state).toBe('suspended');

    await host.dispose();
  });

  it('reports worklet limits to the host diagnostics', async () => {
    const worklet = createWorkletNode();
    installWorklet(worklet);
    const { host, sandbox, diagnostics, mountGuest } = createHarness({ maxStreams: 2 });
    await host.loadDocument(canvas());
    const mount = sandbox.argsOf('mount')?.[0] as { audio: WidgetAudioMountInfo };

    const runtime = mountGuest(mount.audio);
    // The guest still allows four streams; the host tightened the worklet ceiling to two.
    for (let index = 0; index < 3; index += 1) {
      runtime.api(ID).createStream({ sampleRate: 48000 });
    }
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/audio-limit', instanceId: ID }),
    ]);
    runtime.dispose();
    await host.dispose();
  });

  it('stays unavailable without an audio option', async () => {
    const { host, sandbox } = createHarness({ audio: false });
    await host.loadDocument(canvas());

    const mount = sandbox.argsOf('mount')?.[0] as { audio?: WidgetAudioMountInfo };
    expect(mount.audio).toEqual({ state: 'unavailable' });
    expect(sandbox.port).toBeUndefined();
    expect(host.audio.state).toBe('unavailable');
    expect(() => host.audio.setMuted(true)).not.toThrow();
    expect(() => host.audio.suspend()).not.toThrow();

    await host.dispose();
  });
});
