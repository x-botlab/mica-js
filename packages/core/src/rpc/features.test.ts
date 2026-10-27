/// <reference types="node" />
import { MessageChannel } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { DisposableStore } from '../lifecycle';
import { createRpc } from './rpc';
import { defineRpcService } from './types';
import type { RpcOptions } from './types';

const serviceService = defineRpcService<Record<string, (...args: never[]) => unknown>>('service');
const buffersService = defineRpcService<Record<string, (...args: never[]) => unknown>>('buffers');
const eventsService = defineRpcService<Record<string, (...args: never[]) => unknown>>('events');
const barrierService = defineRpcService<Record<string, (...args: never[]) => unknown>>('barrier');

function pair(options: RpcOptions = {}) {
  const { port1, port2 } = new MessageChannel();
  const errors: Error[] = [];
  const client = createRpc(port1, { ...options, onError: (error) => errors.push(error) });
  const server = createRpc(port2, { onError: (error) => errors.push(error) });
  return {
    client,
    server,
    port1,
    port2,
    errors,
    close() {
      client.dispose();
      server.dispose();
      port1.close();
      port2.close();
    },
  };
}

function eventSource() {
  const listeners = new Set<(value: Uint8Array) => void>();
  return {
    listeners,
    onDidData(listener: (value: Uint8Array) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(value: Uint8Array) {
      for (const listener of listeners) listener(value);
    },
    ready() {
      return true;
    },
  };
}

test('rejects malformed envelopes without breaking subsequent traffic', async () => {
  const rpc = pair();
  try {
    rpc.server.register(serviceService, {
      ready() {
        return true;
      },
    });
    const invalid = [
      null,
      [],
      {},
      { kind: 'result', id: 1 },
      { kind: 'call', id: -1 },
      { kind: 'event', id: 1, args: null },
      { kind: 'error', id: 1, name: 1, message: 'bad' },
      { kind: 'listen', id: 1, service: 'service', member: 'onDidData', args: [1] },
      { kind: 'other', id: 1 },
      { kind: 'unlisten', id: 1.5 },
    ];
    for (const value of invalid) rpc.port2.postMessage(value);
    expect(await rpc.client.getProxy<{ ready(): boolean }>(serviceService).ready()).toBe(true);
    expect(rpc.errors).toHaveLength(invalid.length);
    expect(rpc.errors.every((error) => error.name === 'RpcProtocolError')).toBe(true);
  } finally {
    rpc.close();
  }
});

test('clones by default and explicitly transfers arguments and results', async () => {
  const rpc = pair();
  try {
    const outputs: Uint8Array[] = [];
    rpc.server.register(
      buffersService,
      {
        echo(value: Uint8Array) {
          const output = value.slice();
          outputs.push(output);
          return output;
        },
      },
      { transfer: (_member, value) => [(value as Uint8Array<ArrayBuffer>).buffer] },
    );
    const normal = rpc.client.getProxy<{ echo(value: Uint8Array): Uint8Array }>(buffersService);
    const input = new Uint8Array([1, 2, 3]);
    expect(await normal.echo(input)).toEqual(input);
    expect(input.byteLength).toBe(3);
    expect(outputs[0]!.byteLength).toBe(0);
    const transferring = rpc.client.getProxy<{ echo(value: Uint8Array): Uint8Array }>(
      buffersService,
      {
        transfer: (_member, args) => [(args[0] as Uint8Array<ArrayBuffer>).buffer],
      },
    );
    expect(await transferring.echo(input)).toEqual(new Uint8Array([1, 2, 3]));
    expect(input.byteLength).toBe(0);
    expect(outputs[1]!.byteLength).toBe(0);
  } finally {
    rpc.close();
  }
});

test('transfers event arguments and preserves event-before-response order', async () => {
  const rpc = pair();
  try {
    const source = eventSource();
    rpc.server.register(eventsService, source, {
      transfer: (member, value) =>
        member === 'onDidData' ? [(value as [Uint8Array<ArrayBuffer>])[0].buffer] : [],
    });
    const proxy = rpc.client.getProxy<typeof source>(eventsService);
    const values: Uint8Array[] = [];
    const stop = proxy.onDidData((value) => values.push(value));
    await proxy.ready();
    const bytes = new Uint8Array([4, 5]);
    source.publish(bytes);
    expect(await proxy.ready()).toBe(true);
    expect(bytes.byteLength).toBe(0);
    expect(values).toEqual([new Uint8Array([4, 5])]);
    stop();
  } finally {
    rpc.close();
  }
});

test('failed event transfer reports an error and releases its subscription', async () => {
  const rpc = pair();
  try {
    const source = eventSource();
    rpc.server.register(eventsService, source, {
      transfer: () => {
        throw new Error('transfer failed');
      },
    });
    // Only the registration transfer hook is exercised by the event, not by this barrier.
    rpc.server.register(barrierService, {
      ready() {
        return true;
      },
    });
    const barrier = rpc.client.getProxy<{ ready(): boolean }>(barrierService);
    rpc.client
      .getProxy<typeof source>(eventsService)
      .onDidData(() => expect.fail('failed event delivered'));
    await barrier.ready();
    source.publish(new Uint8Array([1]));
    await barrier.ready();
    expect(source.listeners.size).toBe(0);
    expect(rpc.errors.map((error) => error.message)).toContain('transfer failed');
  } finally {
    rpc.close();
  }
});

test('unregistering a service releases subscriptions without unregistering its replacement', async () => {
  const rpc = pair();
  try {
    const source = eventSource();
    const registration = rpc.server.register(eventsService, source);
    const proxy = rpc.client.getProxy<typeof source>(eventsService);
    proxy.onDidData(() => undefined);
    await proxy.ready();
    expect(source.listeners.size).toBe(1);
    registration.dispose();
    rpc.server.register(eventsService, {
      ready() {
        return true;
      },
    });
    registration.dispose();
    expect(await proxy.ready()).toBe(true);
    expect(source.listeners.size).toBe(0);
    expect(rpc.errors.some((error) => error.name === 'ServiceUnregistered')).toBe(true);
  } finally {
    rpc.close();
  }
});

test('times out locally without cancelling execution and ignores late replies', async () => {
  const rpc = pair();
  try {
    let complete: (() => void) | undefined;
    let completed = false;
    rpc.server.register(serviceService, {
      async slow() {
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        completed = true;
        return 1;
      },
      ready() {
        return true;
      },
    });
    const proxy = rpc.client.getProxy<{ slow(): number; ready(): boolean }>(serviceService, {
      timeoutMs: 30,
    });
    await expect(proxy.slow()).rejects.toMatchObject({ name: 'RpcTimeoutError' });
    expect(completed).toBe(false);
    complete!();
    await proxy.ready();
    expect(completed).toBe(true);
    expect(rpc.errors).toEqual([]);
  } finally {
    rpc.close();
  }
});

test('subscription timeout sends cleanup even when registration succeeded remotely', async () => {
  const rpc = pair({ timeoutMs: 30 });
  try {
    const source = eventSource();
    const original = rpc.port2.postMessage.bind(rpc.port2);
    rpc.port2.postMessage = (value: unknown) => {
      if ((value as { kind: string }).kind !== 'result') original(value);
    };
    rpc.server.register(eventsService, source);
    rpc.client.getProxy<typeof source>(eventsService).onDidData(() => undefined);
    await expect
      .poll(() => rpc.errors.some((error) => error.name === 'RpcTimeoutError'))
      .toBe(true);
    await expect.poll(() => source.listeners.size).toBe(0);
  } finally {
    rpc.close();
  }
});

test('errors in observers and disposers do not prevent lifecycle cleanup', async () => {
  const rpc = pair();
  try {
    const store = new DisposableStore();
    let stopped = 0;
    const registration = store.add(
      rpc.server.register(eventsService, {
        onDidData() {
          return () => {
            stopped++;
            throw new Error('cleanup failed');
          };
        },
        ready() {
          return true;
        },
      }),
    );
    const proxy = rpc.client.getProxy<{
      onDidData(listener: () => void): () => void;
      ready(): boolean;
    }>(eventsService);
    proxy.onDidData(() => undefined);
    await proxy.ready();
    const closeEvents: number[] = [];
    rpc.server.onDidError(() => {
      throw new Error('observer failed');
    });
    rpc.server.onDidClose(() => {
      closeEvents.push(1);
      throw new Error('close failed');
    });
    rpc.server.onDidClose(() => {
      closeEvents.push(2);
    });
    store.add(rpc.server);
    store.dispose();
    registration.dispose();
    expect(stopped).toBe(1);
    expect(closeEvents).toEqual([1, 2]);
  } finally {
    rpc.close();
  }
});

test('invalid timeout options fail early', () => {
  const rpc = pair();
  try {
    for (const timeoutMs of [-1, NaN, Infinity, 1.5, 2_147_483_648]) {
      expect(() => rpc.client.getProxy(serviceService, { timeoutMs })).toThrow(RangeError);
    }
  } finally {
    rpc.close();
  }
});
