import { timePs } from '@mica-js/core';
import type { CanvasBindingTarget } from '@mica-js/document/canvas';
import { describe, expect, it, vi } from 'vitest';
import type { WidgetAudioOptions } from '../host/audio/types';
import { FakeAudioContext, createWorkletNode } from '../host/audio/test-helpers';
import type { WidgetSandbox, WidgetSandboxAudio } from '../host/types';
import type { WidgetInputEvent } from '../guest/widget/types';
import {
  widgetAssetFailedEvent,
  widgetConfigureMethod,
  widgetDeliverMethod,
  widgetErrorEvent,
  widgetFrameEvent,
  widgetLoadMethod,
  widgetMountMethod,
  widgetPointerMethod,
  widgetPublishEvent,
  widgetResizeMethod,
  widgetSetAssetsMethod,
  widgetSetBindingsMethod,
  widgetSetPropertiesMethod,
  widgetStepMethod,
  widgetUnmountMethod,
} from '../guest/widget/protocol';
import type { WidgetModule } from '../types';
import { WidgetRuntimeError } from './errors';
import { createWidgetRuntime } from './runtime';
import type {
  IPreparedWidgetInstance,
  IWidgetFrame,
  IWidgetMessage,
  IWidgetRuntimeDiagnostic,
} from './types';

interface IRecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

type Handler = (...args: readonly unknown[]) => unknown;

class FakeSandbox implements WidgetSandbox {
  state: 'ready' | 'terminated' = 'ready';
  readonly calls: IRecordedCall[] = [];
  readonly handlers = new Map<string, Handler>();
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  terminations = 0;
  audio?: WidgetSandboxAudio;

  call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    const handler = this.handlers.get(method);
    try {
      return Promise.resolve(handler?.(...args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  on(type: string, listener: (payload: unknown) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => {
      this.#listeners.get(type)?.delete(listener);
    };
  }

  terminate(): Promise<void> {
    this.state = 'terminated';
    this.terminations += 1;
    return Promise.resolve();
  }

  emit(type: string, payload: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(payload);
  }

  callsOf(method: string): readonly (readonly unknown[])[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

interface IFakeBitmap {
  readonly closed: () => boolean;
  readonly close: ReturnType<typeof vi.fn>;
}

function bitmap(): ImageBitmap & IFakeBitmap {
  let closed = false;
  const fake = {
    closed: () => closed,
    close: vi.fn(() => {
      closed = true;
    }),
  };
  return fake as unknown as ImageBitmap & IFakeBitmap;
}

const demoModule: WidgetModule = {
  definition: {
    properties: { label: { type: 'string', default: 'hello' } },
    ports: {
      value: { direction: 'output', type: 'number' },
      brightness: { direction: 'input', type: 'number' },
      note: { direction: 'input', type: 'string' },
    },
  },
  code: 'export default () => ({});',
};

function prepared(overrides: Partial<IPreparedWidgetInstance> = {}): IPreparedWidgetInstance {
  return {
    instanceId: 'a',
    widget: 'demo:indicator',
    module: demoModule,
    width: 40,
    height: 20,
    dpr: 2,
    ...overrides,
  };
}

const pointer: WidgetInputEvent = { type: 'pointerdown', x: 3, y: 4, button: 0 };

function createHarness(options: { audio?: WidgetAudioOptions } = {}) {
  const sandbox = new FakeSandbox();
  sandbox.handlers.set(widgetConfigureMethod, () => true);
  const runtime = createWidgetRuntime(sandbox, options);
  const publishes: IWidgetMessage[] = [];
  const frames: IWidgetFrame[] = [];
  const diagnostics: IWidgetRuntimeDiagnostic[] = [];
  runtime.onDidPublish((message) => publishes.push(message));
  runtime.onDidRender((frame) => frames.push(frame));
  runtime.onDidDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  return { runtime, sandbox, publishes, frames, diagnostics };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Condition was not met');
}

describe('createWidgetRuntime', () => {
  it('configures explicit stepping and the simulation service before the first mount', async () => {
    const { runtime, sandbox } = createHarness();

    await runtime.mount(prepared());

    expect(sandbox.methods()).toEqual([widgetConfigureMethod, widgetLoadMethod, widgetMountMethod]);
    expect(sandbox.callsOf(widgetConfigureMethod)).toEqual([
      [{ explicitStepping: true, directTopicService: 'simulation-runtime' }],
    ]);
    expect(sandbox.callsOf(widgetMountMethod)[0]?.[0]).toMatchObject({
      instanceId: 'a',
      widget: 'demo:indicator',
      width: 40,
      height: 20,
      dpr: 2,
      props: { label: 'hello' },
      generation: 1,
    });
    await runtime.dispose();
  });

  it('adopts the first frame during mount and closes late or foreign frames', async () => {
    const { runtime, sandbox, frames } = createHarness();
    let finishMount: (() => void) | undefined;
    sandbox.handlers.set(
      widgetMountMethod,
      () =>
        new Promise<void>((resolve) => {
          finishMount = resolve;
        }),
    );

    const mounting = runtime.mount(prepared());
    await until(() => sandbox.callsOf(widgetMountMethod).length === 1);
    const first = bitmap();
    sandbox.emit(widgetFrameEvent, {
      instanceId: 'a',
      bitmap: first,
      width: 40,
      height: 20,
      dpr: 2,
      generation: 1,
    });
    expect(frames).toHaveLength(1);

    finishMount?.();
    await mounting;
    expect(first.closed()).toBe(false);

    const stale = bitmap();
    sandbox.emit(widgetFrameEvent, {
      instanceId: 'a',
      bitmap: stale,
      width: 40,
      height: 20,
      dpr: 2,
      generation: 2,
    });
    expect(stale.closed()).toBe(true);
    expect(frames).toHaveLength(1);

    const foreign = bitmap();
    sandbox.emit(widgetFrameEvent, {
      instanceId: 'missing',
      bitmap: foreign,
      width: 1,
      height: 1,
      dpr: 1,
    });
    expect(foreign.closed()).toBe(true);

    await runtime.unmount('a');
    expect(first.closed()).toBe(true);
    await runtime.dispose();
  });

  it('replaces frames, closes the previous bitmap and increments the sequence', async () => {
    const { runtime, sandbox, frames } = createHarness();
    await runtime.mount(prepared());

    const first = bitmap();
    const second = bitmap();
    sandbox.emit(widgetFrameEvent, {
      instanceId: 'a',
      bitmap: first,
      width: 40,
      height: 20,
      dpr: 2,
    });
    sandbox.emit(widgetFrameEvent, {
      instanceId: 'a',
      bitmap: second,
      width: 50,
      height: 30,
      dpr: 3,
    });

    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(frames[1]).toMatchObject({ width: 50, height: 30, dpr: 3 });
    expect(first.closed()).toBe(true);
    expect(second.closed()).toBe(false);
    await runtime.dispose();
  });

  it('updates geometry, properties and assets; unknown instances reject', async () => {
    const { runtime, sandbox } = createHarness();
    await runtime.mount(prepared());
    sandbox.calls.length = 0;

    const assets = { 'a.bin': new Uint8Array([1, 2, 3]) };
    await runtime.update('a', {
      width: 50,
      height: 30,
      dpr: 3,
      properties: { note: 'fresh' },
      assets,
    });

    expect(sandbox.methods()).toEqual([
      widgetResizeMethod,
      widgetSetPropertiesMethod,
      widgetSetAssetsMethod,
    ]);
    expect(sandbox.callsOf(widgetResizeMethod)).toEqual([['a', 50, 30, 3]]);
    expect(sandbox.callsOf(widgetSetPropertiesMethod)).toEqual([
      ['a', { label: 'hello', note: 'fresh' }],
    ]);
    expect(sandbox.callsOf(widgetSetAssetsMethod)).toEqual([['a', assets]]);

    await expect(runtime.update('missing', { width: 1 })).rejects.toMatchObject({
      code: 'widget/unknown-instance',
    });
    await expect(runtime.update('a', { dpr: 0 })).rejects.toBeInstanceOf(WidgetRuntimeError);
    await runtime.dispose();
  });

  it('serializes concurrent operations', async () => {
    const { runtime, sandbox } = createHarness();
    let finishFirst: (() => void) | undefined;
    sandbox.handlers.set(widgetMountMethod, (request) => {
      if ((request as { instanceId?: string }).instanceId === 'a') {
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      return undefined;
    });

    const first = runtime.mount(prepared());
    await until(() => sandbox.callsOf(widgetMountMethod).length === 1);
    const second = runtime.mount(prepared({ instanceId: 'b' }));

    await tick();
    expect(sandbox.callsOf(widgetLoadMethod)).toHaveLength(1);

    finishFirst?.();
    await first;
    await second;
    expect(
      sandbox
        .callsOf(widgetMountMethod)
        .map((args) => (args[0] as { instanceId: string }).instanceId),
    ).toEqual(['a', 'b']);
    await runtime.dispose();
  });

  it('cleans up a failed mount and allows a retry', async () => {
    const { runtime, sandbox, diagnostics } = createHarness();
    let attempts = 0;
    sandbox.handlers.set(widgetMountMethod, () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('mount exploded'));
      return undefined;
    });

    await expect(runtime.mount(prepared())).rejects.toMatchObject({
      code: 'widget/sandbox-failed',
    });
    expect(sandbox.callsOf(widgetUnmountMethod)).toEqual([['a']]);
    expect(diagnostics.some((entry) => entry.code === 'widget/mount-failed')).toBe(true);

    await runtime.mount(prepared());
    expect(sandbox.callsOf(widgetMountMethod)).toHaveLength(2);
    await runtime.dispose();
  });

  it('queues deliver and dispatch until step, then flushes before stepping', async () => {
    const { runtime, sandbox } = createHarness();
    await runtime.mount(prepared());
    sandbox.calls.length = 0;

    await runtime.deliver({
      instanceId: 'a',
      port: 'brightness',
      payload: 5,
      simTime: timePs(100),
    });
    await runtime.dispatch('a', pointer);
    expect(sandbox.calls).toHaveLength(0);

    await runtime.step({ simTime: timePs(125), dt: timePs(25), mode: 'simulation' });

    expect(sandbox.methods()).toEqual([widgetDeliverMethod, widgetPointerMethod, widgetStepMethod]);
    expect(sandbox.callsOf(widgetDeliverMethod)).toEqual([['a', 'brightness', 5, 100]]);
    expect(sandbox.callsOf(widgetPointerMethod)).toEqual([['a', pointer]]);
    expect(sandbox.callsOf(widgetStepMethod)).toEqual([
      [{ simTime: 125, dt: 25, mode: 'simulation' }],
    ]);
    await runtime.dispose();
  });

  it('rejects deliveries that do not fit the instance definition', async () => {
    const { runtime } = createHarness();
    await runtime.mount(prepared());

    await expect(
      runtime.deliver({
        instanceId: 'missing',
        port: 'brightness',
        payload: 1,
        simTime: timePs(1),
      }),
    ).rejects.toMatchObject({ code: 'widget/unknown-instance' });
    await expect(
      runtime.deliver({ instanceId: 'a', port: 'missing', payload: 1, simTime: timePs(1) }),
    ).rejects.toMatchObject({ code: 'widget/unknown-port' });
    await expect(
      runtime.deliver({ instanceId: 'a', port: 'value', payload: 1, simTime: timePs(1) }),
    ).rejects.toMatchObject({ code: 'widget/invalid-direction' });
    await expect(
      runtime.deliver({ instanceId: 'a', port: 'brightness', payload: 'nope', simTime: timePs(1) }),
    ).rejects.toMatchObject({ code: 'widget/invalid-payload' });
    await expect(
      runtime.deliver({ instanceId: 'a', port: 'brightness', payload: 1, simTime: -1 as never }),
    ).rejects.toMatchObject({ code: 'widget/invalid-time' });
    await expect(runtime.dispatch('missing', pointer)).rejects.toMatchObject({
      code: 'widget/unknown-instance',
    });
    await expect(
      runtime.step({ simTime: timePs(1), dt: timePs(1), mode: 'bogus' as never }),
    ).rejects.toMatchObject({ code: 'widget/invalid-step' });
    await runtime.dispose();
  });

  it('validates publishes against the module definition and keeps direct publishes observable', async () => {
    const { runtime, sandbox, publishes, diagnostics } = createHarness();
    await runtime.mount(prepared());

    sandbox.emit(widgetPublishEvent, {
      instanceId: 'a',
      port: 'value',
      payload: 3,
      simTime: 7,
      direct: true,
    });
    expect(publishes).toEqual([
      { instanceId: 'a', port: 'value', payload: 3, simTime: 7, direct: true },
    ]);

    sandbox.emit(widgetPublishEvent, {
      instanceId: 'a',
      port: 'brightness',
      payload: 3,
      simTime: 8,
    });
    sandbox.emit(widgetPublishEvent, {
      instanceId: 'a',
      port: 'value',
      payload: 'wrong',
      simTime: 9,
    });
    sandbox.emit(widgetPublishEvent, {
      instanceId: 'a',
      port: 'missing',
      payload: 3,
      simTime: 10,
    });
    sandbox.emit(widgetPublishEvent, {
      instanceId: 'missing',
      port: 'value',
      payload: 3,
      simTime: 11,
    });

    expect(publishes).toHaveLength(1);
    expect(diagnostics.filter((entry) => entry.code === 'widget/publish-rejected')).toHaveLength(4);
    await runtime.dispose();
  });

  it('forwards editor-produced routes and rejects malformed ones', async () => {
    const { runtime, sandbox } = createHarness();
    await runtime.mount(prepared());
    sandbox.calls.length = 0;

    const bindings: Record<string, CanvasBindingTarget> = {
      brightness: { symbol: 'led', port: 'anode' },
    };
    await runtime.setBindings('a', bindings);
    expect(sandbox.callsOf(widgetSetBindingsMethod)).toEqual([['a', bindings]]);

    await expect(
      runtime.setBindings('a', { brightness: { symbol: '', port: 'anode' } }),
    ).rejects.toMatchObject({ code: 'widget/invalid-update' });
    await expect(runtime.setBindings('missing', bindings)).rejects.toMatchObject({
      code: 'widget/unknown-instance',
    });
    await runtime.dispose();
  });

  it('turns widget and asset boundary failures into diagnostics', async () => {
    const { runtime, sandbox, diagnostics } = createHarness();
    await runtime.mount(prepared());

    sandbox.emit(widgetErrorEvent, {
      instanceId: 'a',
      phase: 'render',
      error: { name: 'TypeError', message: 'bad canvas' },
    });
    sandbox.emit(widgetErrorEvent, {
      instanceId: 'a',
      phase: 'deliver',
      error: { name: 'Error', message: 'listener failed' },
    });
    sandbox.emit(widgetAssetFailedEvent, {
      instanceId: 'a',
      src: 'a.bin',
      error: { name: 'Error', message: 'missing' },
    });

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      'widget/render-failed',
      'widget/deliver-failed',
      'widget/asset-failed',
    ]);
    expect(diagnostics.every((entry) => entry.instanceId === 'a')).toBe(true);
    await runtime.dispose();
  });

  it('uses the no-op audio controls without audio options', async () => {
    const { runtime } = createHarness();
    expect(runtime.audio.state).toBe('unavailable');
    runtime.audio.setMuted(true);
    runtime.audio.suspend();
    await runtime.dispose();
  });

  it('opens an audio session and forwards the availability lane', async () => {
    const worklet = createWorkletNode();
    const context = new FakeAudioContext();
    const sandbox = new FakeSandbox();
    sandbox.handlers.set(widgetConfigureMethod, () => true);
    const ports: MessagePort[] = [];
    sandbox.audio = {
      attachPort: (port) => ports.push(port),
      setState: vi.fn(),
    };
    const runtime = createWidgetRuntime(sandbox, {
      audio: {
        context: context as unknown as AudioContext,
        getAudioWorklet: async () => worklet.node as unknown as AudioWorkletNode,
      },
    });

    await runtime.mount(prepared());

    expect(runtime.audio.state).toBe('running');
    const mountRequest = sandbox.callsOf(widgetMountMethod)[0]?.[0] as {
      readonly audio?: { readonly state: string; readonly session?: string };
    };
    expect(mountRequest.audio?.state).toBe('running');
    expect(mountRequest.audio?.session).toBeTypeOf('string');
    expect(ports).toHaveLength(1);

    await runtime.dispose();
    for (const port of ports) port.close();
    worklet.dispose();
  });

  it('dispose terminates the owned sandbox and cancels an in-flight mount', async () => {
    const { runtime, sandbox } = createHarness();
    let finishMount: (() => void) | undefined;
    sandbox.handlers.set(
      widgetMountMethod,
      () =>
        new Promise<void>((resolve) => {
          finishMount = resolve;
        }),
    );

    const mounting = runtime.mount(prepared());
    await until(() => sandbox.callsOf(widgetMountMethod).length === 1);
    const frame = bitmap();
    sandbox.emit(widgetFrameEvent, {
      instanceId: 'a',
      bitmap: frame,
      width: 40,
      height: 20,
      dpr: 2,
      generation: 1,
    });

    const disposal = runtime.dispose();
    finishMount?.();

    await expect(mounting).rejects.toMatchObject({ code: 'widget/disposed' });
    await disposal;
    expect(frame.closed()).toBe(true);
    expect(sandbox.state).toBe('terminated');
    expect(sandbox.terminations).toBe(1);
    expect(sandbox.callsOf(widgetUnmountMethod)).toEqual([['a']]);

    await expect(runtime.mount(prepared())).rejects.toMatchObject({ code: 'widget/disposed' });
    expect(runtime.dispose()).toBe(disposal);
  });
});
