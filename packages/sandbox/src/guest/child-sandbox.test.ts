import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import type { PortLike } from '../internal/port';
import { RpcPeer } from '../internal/rpc';
import { CHILD_RESIZE_EVENT, CHILD_SANDBOX_METHODS, CHILD_TERMINATED_EVENT } from '../protocol';
import type { ChildSandboxResponse, SandboxInfo } from '../protocol';
import type { ChildSandboxOptions } from '../types';
import {
  ChildCapabilityRegistry,
  createChildSandbox,
  serializeChildOptions,
} from './child-sandbox';
import type { ChildSandboxLink } from './child-sandbox';

const childId = 'mica-sandbox-2';

function makeInfo(name = 'child'): SandboxInfo {
  return {
    name,
    origin: 'null',
    userAgent: 'node',
    guestMethods: [],
    features: { wasm: false, offscreenCanvas: false, webgl2: false },
  };
}

const source = { type: 'module', code: '$sandbox.export({});' } as const;

interface HarnessOptions {
  request?: (method: string, args: readonly unknown[]) => Promise<unknown>;
  onRequest?: (method: string, args: unknown[]) => unknown;
  onEvent?: (type: string, payload: unknown) => void;
  onNotify?: (method: string, args: unknown[]) => void;
  response?: unknown;
}

function createHarness(options: HarnessOptions = {}) {
  const channel = new MessageChannel();
  const hostListeners = new Map<string, Set<(payload: unknown) => void>>();
  const calls: { method: string; args: readonly unknown[] }[] = [];
  const info = makeInfo();

  const link: ChildSandboxLink = {
    async request(method, args) {
      calls.push({ method, args });
      if (options.request) return options.request(method, args);
      if (method === CHILD_SANDBOX_METHODS.create) {
        if (options.response !== undefined) return options.response;
        return {
          childId,
          name: 'child',
          state: 'ready',
          info,
          port: channel.port2 as unknown as MessagePort,
        } satisfies ChildSandboxResponse;
      }
      if (method === CHILD_SANDBOX_METHODS.terminate) return undefined;
      throw new Error(`unexpected host request: ${method}`);
    },
    notify(method, args) {
      calls.push({ method, args });
    },
    on(type, listener) {
      let listeners = hostListeners.get(type);
      if (!listeners) {
        listeners = new Set();
        hostListeners.set(type, listeners);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const childPeer = new RpcPeer(channel.port1 as unknown as PortLike, {
    onRequest: options.onRequest ?? (() => undefined),
    onEvent: options.onEvent ?? (() => undefined),
    onNotify: options.onNotify ?? (() => undefined),
  });

  const close = (): void => {
    childPeer.destroy(new SandboxError('terminated', 'test cleanup'));
    try {
      channel.port2.close();
    } catch {
      // Already closed by the parent handle.
    }
  };

  return {
    link,
    calls,
    info,
    childPeer,
    close,
    emitHostEvent(type: string, payload: unknown) {
      for (const listener of hostListeners.get(type) ?? []) listener(payload);
    },
  };
}

const harnesses: { close(): void }[] = [];

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: HarnessOptions = {}) {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const item of harnesses.splice(0)) item.close();
});

function makeOptions(overrides: Partial<ChildSandboxOptions> = {}): ChildSandboxOptions {
  return { name: 'child', source, ...overrides };
}

describe('serializeChildOptions', () => {
  it('keeps the source and forwards limits', () => {
    const request = serializeChildOptions({
      name: 'sim',
      source: { type: 'script', code: 'self.x = 1;' },
      capabilities: { getConfig: () => ({}), draw: () => undefined },
      maxFps: 30,
      captureConsole: false,
      callTimeoutMs: 250,
    });

    expect(request).toEqual({
      name: 'sim',
      source: { type: 'script', code: 'self.x = 1;' },
      maxFps: 30,
      captureConsole: false,
      callTimeoutMs: 250,
    });
  });

  it.each([
    ['a missing object', undefined],
    ['an empty name', { name: '', source }],
    ['a missing source', { name: 'child' }],
    ['an unsupported source type', { name: 'child', source: { type: 'json', code: 'x' } }],
    ['empty source code', { name: 'child', source: { type: 'module', code: ' ' } }],
    ['a non-function capability', { name: 'child', source, capabilities: { bad: 1 } }],
  ])('rejects %s', (_label, value) => {
    expect(() => serializeChildOptions(value as ChildSandboxOptions)).toThrow(SandboxError);
  });

  it('rejects a DOM canvas', () => {
    expect(() =>
      serializeChildOptions({
        ...makeOptions(),
        canvas: {} as HTMLCanvasElement,
      }),
    ).toThrow(/resolveChildCanvas/);
  });
});

describe('createChildSandbox', () => {
  it('creates the child once and then talks over the port', async () => {
    const onRequest = vi.fn((method: string, args: unknown[]) =>
      method === 'greet' ? `Hello, ${String(args[0])}!` : undefined,
    );
    const host = harness({ onRequest });
    const registry = new ChildCapabilityRegistry();

    const child = await createChildSandbox(makeOptions(), host.link, registry);

    expect(child.id).toBe(childId);
    expect(child.name).toBe('child');
    expect(child.state).toBe('ready');
    await expect(child.call('greet', 'World')).resolves.toBe('Hello, World!');

    // Only creation crossed the host boundary.
    expect(host.calls.map((call) => call.method)).toEqual([CHILD_SANDBOX_METHODS.create]);
    expect(onRequest).toHaveBeenCalledWith('greet', ['World']);
  });

  it('routes child→parent capability calls to the parent registry over the port', async () => {
    const host = harness();
    const registry = new ChildCapabilityRegistry();
    const getConfig = vi.fn(() => ({ timestep: 1e-6 }));

    await createChildSandbox(makeOptions({ capabilities: { getConfig } }), host.link, registry);

    await expect(host.childPeer.request('getConfig', [])).resolves.toEqual({ timestep: 1e-6 });
    expect(getConfig).toHaveBeenCalledTimes(1);

    await expect(host.childPeer.request('missing', [])).rejects.toMatchObject({
      code: 'capability-not-found',
    });
  });

  it('reports capability failures back to the child', async () => {
    const host = harness();
    const registry = new ChildCapabilityRegistry();

    await createChildSandbox(
      makeOptions({
        capabilities: {
          explode: () => {
            throw new Error('boom');
          },
        },
      }),
      host.link,
      registry,
    );

    await expect(host.childPeer.request('explode', [])).rejects.toMatchObject({
      message: 'boom',
    });
  });

  it('delivers events in both directions and unsubscribes', async () => {
    const childEvents: unknown[] = [];
    const host = harness({ onEvent: (type, payload) => childEvents.push({ type, payload }) });
    const registry = new ChildCapabilityRegistry();

    const child = await createChildSandbox(makeOptions(), host.link, registry);
    const listener = vi.fn();
    const unsubscribe = child.on('tick', listener);

    host.childPeer.emit('tick', { dt: 16 });
    await flush();
    expect(listener).toHaveBeenCalledWith({ dt: 16 });

    unsubscribe();
    host.childPeer.emit('tick', { dt: 17 });
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);

    child.emit('command', { joint: 2 });
    await flush();
    expect(childEvents).toEqual([{ type: 'command', payload: { joint: 2 } }]);
  });

  it('transfers buffers over the direct port', async () => {
    const host = harness({
      onRequest: (method, args) =>
        method === 'byteLength' ? (args[0] as ArrayBuffer).byteLength : undefined,
    });
    const registry = new ChildCapabilityRegistry();
    const child = await createChildSandbox(makeOptions(), host.link, registry);

    const buffer = new ArrayBuffer(16);
    await expect(child.request('byteLength', [buffer], { transfer: [buffer] })).resolves.toBe(16);
    expect(buffer.byteLength).toBe(0);
  });

  it('surfaces uncaught child errors as error events', async () => {
    const host = harness();
    const registry = new ChildCapabilityRegistry();
    const child = await createChildSandbox(makeOptions(), host.link, registry);
    const listener = vi.fn();
    child.on('error', listener);

    host.childPeer.postGuestError(new Error('boom'));

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalled();
    });
    expect((listener.mock.calls[0]?.[0] as Error).message).toBe('boom');
  });

  it('delivers notify and resize without waiting for a response', async () => {
    const onNotify = vi.fn();
    const onEvent = vi.fn();
    const host = harness({ onNotify, onEvent });
    const registry = new ChildCapabilityRegistry();

    const child = await createChildSandbox(makeOptions(), host.link, registry);

    child.notify('reset', [1, 2]);
    await flush();
    expect(onNotify).toHaveBeenCalledWith('reset', [1, 2]);

    child.resize({ width: 320, height: 200, dpr: 2 });
    await flush();
    expect(onEvent).toHaveBeenCalledWith(CHILD_RESIZE_EVENT, {
      width: 320,
      height: 200,
      dpr: 2,
    });
  });

  it('applies the configured call timeout', async () => {
    const host = harness({ onRequest: () => new Promise(() => undefined) });
    const registry = new ChildCapabilityRegistry();

    const child = await createChildSandbox(makeOptions({ callTimeoutMs: 30 }), host.link, registry);

    await expect(child.call('never')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('closes the port and asks the host to terminate', async () => {
    const host = harness();
    const registry = new ChildCapabilityRegistry();
    const child = await createChildSandbox(makeOptions(), host.link, registry);

    await child.terminate('done');

    expect(host.calls.map((call) => call.method)).toEqual([
      CHILD_SANDBOX_METHODS.create,
      CHILD_SANDBOX_METHODS.terminate,
    ]);
    expect(host.calls[1]?.args).toEqual([{ childId, reason: 'done' }]);
    expect(child.state).toBe('terminated');
    await expect(child.call('greet')).rejects.toMatchObject({ code: 'terminated' });

    // Idempotent: no second host terminate.
    await child.terminate();
    expect(host.calls).toHaveLength(2);
  });

  it('mirrors terminations performed by the host', async () => {
    const host = harness();
    const registry = new ChildCapabilityRegistry();
    const child = await createChildSandbox(makeOptions(), host.link, registry);

    host.emitHostEvent(CHILD_TERMINATED_EVENT, { childId: 'someone-else', reason: 'nope' });
    expect(child.state).toBe('ready');

    host.emitHostEvent(CHILD_TERMINATED_EVENT, { childId, reason: 'parent terminated' });
    expect(child.state).toBe('terminated');
    await expect(child.call('greet')).rejects.toMatchObject({ code: 'terminated' });
  });

  it('drops capabilities when creation fails', async () => {
    const host = harness({
      request: async () => {
        throw new SandboxError('boot-failed', 'nope');
      },
    });
    const registry = new ChildCapabilityRegistry();

    await expect(
      createChildSandbox(
        makeOptions({ capabilities: { getConfig: () => 1 } }),
        host.link,
        registry,
      ),
    ).rejects.toMatchObject({ code: 'boot-failed' });

    await expect(registry.invoke('child', 'getConfig', [])).rejects.toMatchObject({
      code: 'capability-not-found',
    });
  });

  it('rejects a malformed host response', async () => {
    const missingPort = harness({ response: { childId, name: 'child', info: makeInfo() } });
    const registry = new ChildCapabilityRegistry();

    await expect(
      createChildSandbox(makeOptions(), missingPort.link, registry),
    ).rejects.toMatchObject({ code: 'protocol' });
  });

  it('validates event names', async () => {
    const host = harness();
    const registry = new ChildCapabilityRegistry();
    const child = await createChildSandbox(makeOptions(), host.link, registry);

    expect(() => child.on('', () => undefined)).toThrow(SandboxError);
    expect(() => child.emit('mica:terminate')).toThrow(/reserved/);
  });
});
