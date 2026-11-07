import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import type { PortLike } from '../internal/port';
import { RpcPeer } from '../internal/rpc';
import { CHILD_RESIZE_EVENT } from '../protocol';
import { ParentChannel } from './parent-channel';
import type { ParentChannelHandlers } from './parent-channel';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface HarnessOptions {
  handlers?: Partial<ParentChannelHandlers>;
  parent?: {
    onRequest?: (method: string, args: unknown[]) => unknown;
    onNotify?: (method: string, args: unknown[]) => void;
    onEvent?: (type: string, payload: unknown) => void;
    onGuestError?: (error: unknown) => void;
  };
}

function createHarness(options: HarnessOptions = {}) {
  const channel = new MessageChannel();

  const handlers: ParentChannelHandlers = {
    onRequest: vi.fn(() => 'handled'),
    onEvent: vi.fn(),
    onResize: vi.fn(),
    onError: vi.fn(),
    exportMethods: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    unsubscribe: vi.fn(),
    ...options.handlers,
  };

  const parent = new RpcPeer(channel.port2 as unknown as PortLike, {
    onRequest: options.parent?.onRequest ?? (() => undefined),
    onEvent: options.parent?.onEvent ?? (() => undefined),
    onNotify: options.parent?.onNotify ?? (() => undefined),
    onGuestError: options.parent?.onGuestError ?? (() => undefined),
  });
  const child = new ParentChannel(channel.port1 as unknown as PortLike, handlers);

  const close = (): void => {
    child.destroy('test cleanup');
    parent.destroy(new SandboxError('terminated', 'test cleanup'));
  };

  return { handlers, parent, child, close };
}

const harnesses: { close(): void }[] = [];

function harness(options: HarnessOptions = {}) {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const item of harnesses.splice(0)) {
    try {
      item.close();
    } catch {
      // Ports may already be closed by a test.
    }
  }
});

describe('ParentChannel', () => {
  it('dispatches parent requests to the child method table', async () => {
    const step = vi.fn((deltaMs: number) => deltaMs * 2);
    const { parent } = harness({
      handlers: {
        onRequest: (method, args) => (method === 'step' ? step(args[0] as number) : undefined),
      },
    });

    await expect(parent.request('step', [21])).resolves.toBe(42);
    expect(step).toHaveBeenCalledWith(21);
  });

  it('delivers parent events and notifications to the runtime handlers', async () => {
    const { parent, handlers } = harness();

    parent.emit('applyForce', { body: 1 });
    await vi.waitFor(() => {
      expect(handlers.onEvent).toHaveBeenCalledWith('applyForce', { body: 1 });
    });

    parent.notify('reset', [3]);
    await vi.waitFor(() => {
      expect(handlers.onRequest).toHaveBeenCalledWith('reset', [3]);
    });
  });

  it('routes resize events to onResize and filters reserved events', async () => {
    const { parent, handlers } = harness();

    parent.emit(CHILD_RESIZE_EVENT, { width: 320, height: 200, dpr: 2 });
    await vi.waitFor(() => {
      expect(handlers.onResize).toHaveBeenCalledWith({ width: 320, height: 200, dpr: 2 });
    });

    parent.emit('mica:terminate', null);
    parent.emit('mica:frame', {});
    await flush();

    expect(handlers.onEvent).not.toHaveBeenCalled();
  });

  it('sends child capability calls to the parent', async () => {
    const seen: { method: string; args: unknown[] }[] = [];
    const { child } = harness({
      parent: {
        onRequest: (method, args) => {
          seen.push({ method, args });
          return { timestep: 1e-6 };
        },
      },
    });

    await expect(child.invoke('getConfig')).resolves.toEqual({ timestep: 1e-6 });
    await expect(child.invokeWith('getConfig', ['x'])).resolves.toEqual({ timestep: 1e-6 });
    expect(seen).toEqual([
      { method: 'getConfig', args: [] },
      { method: 'getConfig', args: ['x'] },
    ]);
  });

  it('sends child events and notifications to the parent', async () => {
    const events: unknown[] = [];
    const notifications: unknown[] = [];
    const { child } = harness({
      parent: {
        onEvent: (type, payload) => events.push({ type, payload }),
        onNotify: (method, args) => notifications.push({ method, args }),
      },
    });

    child.emit('tick', { dt: 16 });
    child.notify('frameDone', [1]);
    await vi.waitFor(() => {
      expect(events).toEqual([{ type: 'tick', payload: { dt: 16 } }]);
      expect(notifications).toEqual([{ method: 'frameDone', args: [1] }]);
    });
  });

  it('delegates export/on/off to the runtime', () => {
    const { child, handlers } = harness();
    const listener = (): void => undefined;

    child.export({ step: () => 1 });
    expect(handlers.exportMethods).toHaveBeenCalledWith({ step: expect.any(Function) });

    const unsubscribe = child.on('tick', listener);
    expect(handlers.subscribe).toHaveBeenCalledWith('tick', listener);
    unsubscribe();

    child.off('tick', listener);
    expect(handlers.unsubscribe).toHaveBeenCalledWith('tick', listener);
  });

  it('forwards handler failures without a response channel to the runtime', async () => {
    const error = new Error('notify exploded');
    const { parent, handlers } = harness({
      handlers: {
        onRequest: () => {
          throw error;
        },
      },
    });

    parent.notify('bad', []);
    await vi.waitFor(() => {
      expect(handlers.onError).toHaveBeenCalledWith(error);
    });
  });

  it('reports uncaught child errors to the parent', async () => {
    const errors: unknown[] = [];
    const { child } = harness({ parent: { onGuestError: (error) => errors.push(error) } });

    child.reportError(new Error('guest blew up'));
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect((errors[0] as Error).message).toBe('guest blew up');
  });

  it('rejects calls after destroy', async () => {
    const { child } = harness();
    child.destroy('done');

    await expect(child.invoke('getConfig')).rejects.toMatchObject({ code: 'terminated' });
  });
});
