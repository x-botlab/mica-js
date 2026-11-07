import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import type { PortLike } from '../internal/port';
import { RpcPeer } from '../internal/rpc';
import { isCapabilityTransfer, unpackTransfer } from '../internal/transfer';
import { CHILD_SANDBOX_METHODS } from '../protocol';
import type { ChildSandboxRequest, ChildSandboxResponse, SandboxInfo } from '../protocol';
import type { ChildSandboxRef, SandboxHandle, SandboxHostOptions } from '../types';
import { ChildSandboxRegistry, isChildSandboxMethod } from './child-sandboxes';
import type { ChildSandboxDefaults } from './child-sandboxes';

function makeInfo(name = 'child'): SandboxInfo {
  return {
    name,
    origin: 'null',
    userAgent: 'node',
    guestMethods: [],
    features: { wasm: false, offscreenCanvas: false, webgl2: false },
  };
}

let handleCounter = 0;

function createFakeHandle(overrides: Partial<SandboxHandle> = {}): SandboxHandle {
  const handle = {
    id: `mica-sandbox-${++handleCounter}`,
    name: 'child',
    state: 'ready' as const,
    info: makeInfo(),
    canvas: undefined,
    call: vi.fn(),
    request: vi.fn(),
    notify: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(() => () => undefined),
    off: vi.fn(),
    resize: vi.fn(),
    terminate: vi.fn(async () => undefined),
    ...overrides,
  };
  return handle as unknown as SandboxHandle;
}

const source = { type: 'module', code: '$sandbox.export({});' } as const;

function request(overrides: Partial<ChildSandboxRequest> = {}): ChildSandboxRequest {
  return { name: 'sim', source, ...overrides };
}

interface HarnessOptions {
  create?: (options: SandboxHostOptions, parentPort: MessagePort) => Promise<SandboxHandle>;
  defaults?: ChildSandboxDefaults;
  resolveCanvas?: (child: ChildSandboxRef) => HTMLCanvasElement | undefined;
  notifyTerminated?: (payload: { childId: string; name: string; reason: string }) => void;
}

function createHarness(options: HarnessOptions = {}) {
  const created: { options: SandboxHostOptions; parentPort: MessagePort }[] = [];
  const notified: { childId: string; name: string; reason: string }[] = [];
  const create = options.create;
  const registry = new ChildSandboxRegistry({
    owner: 'parent',
    defaults: options.defaults ?? {},
    create: async (childOptions, parentPort) => {
      created.push({ options: childOptions, parentPort });
      if (create) return create(childOptions, parentPort);
      return createFakeHandle({ name: childOptions.name ?? 'child' });
    },
    ...(options.resolveCanvas ? { resolveCanvas: options.resolveCanvas } : {}),
    notifyTerminated: options.notifyTerminated ?? ((payload) => notified.push(payload)),
  });
  return { registry, created, notified };
}

const openPorts: MessagePort[] = [];

function track<T extends MessagePort>(port: T): T {
  openPorts.push(port);
  return port;
}

function unwrap(result: unknown): {
  value: ChildSandboxResponse;
  transfer: Transferable[];
} {
  expect(isCapabilityTransfer(result)).toBe(true);
  const unpacked = unpackTransfer(result) as {
    value: ChildSandboxResponse;
    transfer: Transferable[];
  };
  track(unpacked.value.port);
  return unpacked;
}

afterEach(() => {
  for (const port of openPorts.splice(0)) {
    try {
      port.close();
    } catch {
      // Already closed by a test.
    }
  }
});

describe('isChildSandboxMethod', () => {
  it('recognizes only lifecycle methods', () => {
    expect(isChildSandboxMethod(CHILD_SANDBOX_METHODS.create)).toBe(true);
    expect(isChildSandboxMethod(CHILD_SANDBOX_METHODS.terminate)).toBe(true);
    expect(isChildSandboxMethod('sandbox:childCall')).toBe(false);
    expect(isChildSandboxMethod('render')).toBe(false);
  });
});

describe('ChildSandboxRegistry', () => {
  it('boots a child, inherits defaults, and returns a transferred parent port', async () => {
    const resolveCanvas = vi.fn(() => ({}) as HTMLCanvasElement);
    const { registry, created } = createHarness({
      resolveCanvas,
      defaults: {
        hidden: true,
        container: {} as HTMLElement,
        bootTimeoutMs: 1234,
        onLog: vi.fn(),
      },
    });

    const result = await registry.invoke(CHILD_SANDBOX_METHODS.create, [
      request({ maxFps: 30, captureConsole: false, callTimeoutMs: 250 }),
    ]);
    const { value, transfer } = unwrap(result);

    expect(value.childId).toMatch(/^mica-sandbox-/);
    expect(value.name).toBe('sim');
    expect(value.state).toBe('ready');
    expect(value.info).toEqual(makeInfo());
    expect(transfer).toEqual([value.port]);

    expect(resolveCanvas).toHaveBeenCalledWith({ name: 'sim', index: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]?.options).toMatchObject({
      name: 'sim',
      source,
      capabilities: {},
      hidden: true,
      bootTimeoutMs: 1234,
      maxFps: 30,
      captureConsole: false,
      callTimeoutMs: 250,
    });
    expect(created[0]?.options.canvas).toBeDefined();
    expect(created[0]?.parentPort).toBeInstanceOf(MessagePort);
    expect(value.port).toBeInstanceOf(MessagePort);
  });

  it('increments the composition index per child', async () => {
    const resolveCanvas = vi.fn((child: ChildSandboxRef): HTMLCanvasElement | undefined => {
      void child;
      return undefined;
    });
    const { registry } = createHarness({ resolveCanvas });

    unwrap(await registry.invoke(CHILD_SANDBOX_METHODS.create, [request({ name: 'a' })]));
    unwrap(await registry.invoke(CHILD_SANDBOX_METHODS.create, [request({ name: 'b' })]));

    expect(resolveCanvas.mock.calls.map(([ref]) => ref.index)).toEqual([0, 1]);
  });

  it('rejects duplicate names until the child is terminated', async () => {
    const { registry } = createHarness();
    const first = unwrap(await registry.invoke(CHILD_SANDBOX_METHODS.create, [request()])).value;

    await expect(registry.invoke(CHILD_SANDBOX_METHODS.create, [request()])).rejects.toMatchObject({
      code: 'invalid-options',
    });

    await registry.invoke(CHILD_SANDBOX_METHODS.terminate, [{ childId: first.childId }]);

    const second = unwrap(await registry.invoke(CHILD_SANDBOX_METHODS.create, [request()])).value;

    expect(first.childId).not.toBe(second.childId);
  });

  it('terminates one child and notifies the parent guest', async () => {
    const handle = createFakeHandle();
    const { registry, notified } = createHarness({ create: async () => handle });
    const child = unwrap(await registry.invoke(CHILD_SANDBOX_METHODS.create, [request()])).value;

    await registry.invoke(CHILD_SANDBOX_METHODS.terminate, [
      { childId: child.childId, reason: 'done' },
    ]);

    expect(handle.terminate).toHaveBeenCalledWith('done');
    expect(notified).toEqual([{ childId: handle.id, name: 'sim', reason: 'done' }]);

    // Unknown ids are ignored.
    await expect(
      registry.invoke(CHILD_SANDBOX_METHODS.terminate, [{ childId: child.childId }]),
    ).resolves.toBeUndefined();
    expect(handle.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates every child once and then refuses new ones', async () => {
    const handles = [createFakeHandle(), createFakeHandle()];
    let next = 0;
    const { registry } = createHarness({ create: async () => handles[next++]! });

    const first = unwrap(
      await registry.invoke(CHILD_SANDBOX_METHODS.create, [request({ name: 'a' })]),
    ).value;
    const second = unwrap(
      await registry.invoke(CHILD_SANDBOX_METHODS.create, [request({ name: 'b' })]),
    ).value;

    await registry.terminateAll('shutdown');
    await registry.terminateAll('shutdown again');

    for (const handle of handles) {
      expect(handle.terminate).toHaveBeenCalledTimes(1);
      expect(handle.terminate).toHaveBeenCalledWith('shutdown');
    }
    await expect(
      registry.invoke(CHILD_SANDBOX_METHODS.create, [request({ name: 'c' })]),
    ).rejects.toMatchObject({ code: 'terminated' });

    expect(first.childId).not.toBe(second.childId);
  });

  it('wraps boot failures and releases the name', async () => {
    let attempt = 0;
    const { registry } = createHarness({
      create: async (options) => {
        if (attempt++ === 0) throw new Error('kaput');
        return createFakeHandle({ name: options.name ?? 'child' });
      },
    });

    await expect(registry.invoke(CHILD_SANDBOX_METHODS.create, [request()])).rejects.toMatchObject({
      code: 'boot-failed',
      message: expect.stringContaining('kaput'),
    });

    unwrap(await registry.invoke(CHILD_SANDBOX_METHODS.create, [request()]));
  });

  it('propagates SandboxError failures unchanged', async () => {
    const { registry } = createHarness({
      create: async () => {
        throw new SandboxError('invalid-options', 'bad child');
      },
    });

    await expect(registry.invoke(CHILD_SANDBOX_METHODS.create, [request()])).rejects.toMatchObject({
      code: 'invalid-options',
      message: 'bad child',
    });
  });

  it('kills a child that finished booting after its parent terminated', async () => {
    let resolveCreate!: (handle: SandboxHandle) => void;
    const pending = new Promise<SandboxHandle>((resolve) => {
      resolveCreate = resolve;
    });
    const handle = createFakeHandle();
    const { registry } = createHarness({ create: () => pending });

    const creating = registry.invoke(CHILD_SANDBOX_METHODS.create, [request()]);
    await Promise.resolve();
    await registry.terminateAll('parent terminated');
    resolveCreate(handle);

    await expect(creating).rejects.toMatchObject({ code: 'terminated' });
    expect(handle.terminate).toHaveBeenCalledWith('parent terminated');
  });

  it('wires parent and child over the transferred port', async () => {
    const childPeers: RpcPeer[] = [];
    const handle = createFakeHandle();
    const { registry } = createHarness({
      create: async (options, parentPort) => {
        childPeers.push(
          new RpcPeer(parentPort as unknown as PortLike, {
            onRequest: (method, args) => `${options.name ?? 'child'}:${method}:${args.join(',')}`,
            onEvent: () => undefined,
          }),
        );
        return handle;
      },
    });

    const child = unwrap(await registry.invoke(CHILD_SANDBOX_METHODS.create, [request()])).value;
    const parentPeer = new RpcPeer(child.port as unknown as PortLike, {
      onRequest: () => undefined,
      onEvent: () => undefined,
    });

    await expect(parentPeer.request('ping', [1, 2])).resolves.toBe('sim:ping:1,2');

    parentPeer.destroy(new SandboxError('terminated', 'done'));
    for (const peer of childPeers) peer.destroy(new SandboxError('terminated', 'done'));
  });
});
