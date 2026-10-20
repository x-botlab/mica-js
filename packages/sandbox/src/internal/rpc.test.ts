import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import type { PortLike } from './port';
import { RpcPeer } from './rpc';
import type { RpcHandlers } from './rpc';
import { transferable } from './transfer';

function createPeerPair(overrides: { a?: Partial<RpcHandlers>; b?: Partial<RpcHandlers> } = {}) {
  const channel = new MessageChannel();
  const handlersA: RpcHandlers = {
    onRequest: () => undefined,
    onEvent: () => undefined,
    ...overrides.a,
  };
  const handlersB: RpcHandlers = {
    onRequest: () => undefined,
    onEvent: () => undefined,
    ...overrides.b,
  };
  return {
    a: new RpcPeer(channel.port1 as unknown as PortLike, handlersA),
    b: new RpcPeer(channel.port2 as unknown as PortLike, handlersB),
    channel,
  };
}

describe('RpcPeer', () => {
  it('round-trips requests in both directions', async () => {
    const { a, b } = createPeerPair({
      a: { onRequest: (method, args) => (args[0] as number) * 2 },
      b: { onRequest: (method, args) => `${method}:${String(args[0])}` },
    });

    await expect(a.request('hello', ['world'])).resolves.toBe('hello:world');
    await expect(b.request('double', [21])).resolves.toBe(42);

    a.destroy(new SandboxError('terminated', 'done'));
    b.destroy(new SandboxError('terminated', 'done'));
  });

  it('matches concurrent responses to the right request', async () => {
    const { a, b } = createPeerPair({
      b: {
        onRequest: async (method, args) => {
          const value = args[0] as number;
          await new Promise((resolve) => setTimeout(resolve, value % 5));
          return { method, value };
        },
      },
    });

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => a.request('echo', [index])),
    );

    expect(results).toEqual(
      Array.from({ length: 25 }, (_, index) => ({ method: 'echo', value: index })),
    );

    a.destroy(new SandboxError('terminated', 'done'));
    b.destroy(new SandboxError('terminated', 'done'));
  });

  it('propagates errors from the handler', async () => {
    const { a, b } = createPeerPair({
      b: {
        onRequest: () => {
          throw new SandboxError('capability-failed', 'handler exploded');
        },
      },
    });

    await expect(a.request('boom')).rejects.toMatchObject({
      name: 'SandboxError',
      message: 'handler exploded',
      code: 'capability-failed',
    });

    a.destroy(new SandboxError('terminated', 'done'));
    b.destroy(new SandboxError('terminated', 'done'));
  });

  it('rejects when a request times out', async () => {
    const { a, b } = createPeerPair({
      b: { onRequest: () => new Promise(() => undefined) },
    });

    await expect(a.request('slow', [], { timeoutMs: 40 })).rejects.toMatchObject({
      code: 'timeout',
    });

    a.destroy(new SandboxError('terminated', 'done'));
    b.destroy(new SandboxError('terminated', 'done'));
  });

  it('delivers notifications and events', async () => {
    const onNotify = vi.fn();
    const onEvent = vi.fn();
    const { a, b } = createPeerPair({ b: { onNotify, onEvent } });

    a.notify('reset', [1]);
    a.emit('tick', { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onNotify).toHaveBeenCalledWith('reset', [1]);
    expect(onEvent).toHaveBeenCalledWith('tick', { n: 1 });

    a.destroy(new SandboxError('terminated', 'done'));
    b.destroy(new SandboxError('terminated', 'done'));
  });

  it('moves transferables instead of copying', async () => {
    const { a, b } = createPeerPair({
      b: {
        onRequest: () => {
          const buffer = new ArrayBuffer(8);
          return transferable(buffer, [buffer]);
        },
      },
    });

    const received = (await a.request('wasm')) as ArrayBuffer;
    expect(received).toBeInstanceOf(ArrayBuffer);
    expect(received.byteLength).toBe(8);

    a.destroy(new SandboxError('terminated', 'done'));
    b.destroy(new SandboxError('terminated', 'done'));
  });

  it('rejects pending requests when destroyed', async () => {
    const { a, b } = createPeerPair({ b: { onRequest: () => new Promise(() => undefined) } });
    const pending = a.request('hangs');

    a.destroy(new SandboxError('terminated', 'gone'));

    await expect(pending).rejects.toMatchObject({ code: 'terminated' });
    await expect(a.request('after')).rejects.toMatchObject({ code: 'terminated' });

    b.destroy(new SandboxError('terminated', 'done'));
  });

  it('reports malformed messages instead of throwing', async () => {
    const onProtocolError = vi.fn();
    const channel = new MessageChannel();
    const peer = new RpcPeer(channel.port1 as unknown as PortLike, {
      onRequest: () => undefined,
      onEvent: () => undefined,
      onProtocolError,
    });

    channel.port2.postMessage({ nonsense: true });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    peer.destroy(new SandboxError('terminated', 'done'));
  });
});
