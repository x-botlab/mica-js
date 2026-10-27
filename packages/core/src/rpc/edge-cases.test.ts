/// <reference types="node" />
import { MessageChannel } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { createRpc } from './rpc';
import { defineRpcService } from './types';

const serviceService = defineRpcService<Record<string, (...args: never[]) => unknown>>('service');

test('service tokens keep wire messages keyed by strings', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = createRpc(port1);
  const server = createRpc(port2);
  const service = defineRpcService<{ ready(): boolean }>('service-token');
  const keys: string[] = [];
  port2.on('message', (message: { kind?: string; service?: string }) => {
    if (message.kind === 'call') keys.push(message.service!);
  });
  try {
    server.register(service, { ready: () => true });
    expect(await client.getProxy(service).ready()).toBe(true);
    expect(keys).toEqual(['service-token']);
  } finally {
    client.dispose();
    server.dispose();
    port1.close();
    port2.close();
  }
});

test('duplicate request IDs are reported without executing the request twice', async () => {
  const { port1, port2 } = new MessageChannel();
  const errors: Error[] = [];
  const server = createRpc(port1, { onError: (error) => errors.push(error) });
  let calls = 0;
  server.register(serviceService, {
    run() {
      return ++calls;
    },
  });
  const response = new Promise<void>((resolve) => {
    port2.on('message', () => {
      resolve();
    });
  });
  try {
    const message = { kind: 'call', id: 1, service: 'service', member: 'run', args: [] };
    port2.postMessage(message);
    port2.postMessage(message);
    await response;
    await expect.poll(() => errors.length).toBe(1);
    expect(calls).toBe(1);
    expect(errors[0]!.name).toBe('RpcProtocolError');
  } finally {
    server.dispose();
    port1.close();
    port2.close();
  }
});

test('events emitted during registration arrive before the next call resolves', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = createRpc(port1);
  const server = createRpc(port2);
  try {
    server.register(serviceService, {
      onDidValue(listener: (value: number) => void) {
        listener(7);
        return () => {};
      },
      ready() {
        return true;
      },
    });
    const proxy = client.getProxy<{
      onDidValue(listener: (value: number) => void): () => void;
      ready(): boolean;
    }>(serviceService);
    const values: number[] = [];
    proxy.onDidValue((value) => values.push(value));
    await proxy.ready();
    expect(values).toEqual([7]);
  } finally {
    client.dispose();
    server.dispose();
    port1.close();
    port2.close();
  }
});

test('unclonable arguments and throwing transfer selectors reject without poisoning later calls', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = createRpc(port1);
  const server = createRpc(port2);
  try {
    server.register(serviceService, {
      run(value: unknown) {
        void value;
        return 1;
      },
    });
    const proxy = client.getProxy<{ run(value: unknown): number }>(serviceService);
    await expect(proxy.run(() => {})).rejects.toMatchObject({ name: 'DataCloneError' });
    const badTransfer = client.getProxy<{ run(value: unknown): number }>(serviceService, {
      transfer: () => {
        throw new Error('selector failed');
      },
    });
    await expect(badTransfer.run(1)).rejects.toThrow('selector failed');
    expect(await proxy.run(1)).toBe(1);
  } finally {
    client.dispose();
    server.dispose();
    port1.close();
    port2.close();
  }
});

test('event listener failure does not suppress other subscriptions or response settlement', async () => {
  const { port1, port2 } = new MessageChannel();
  const errors: Error[] = [];
  const client = createRpc(port1);
  const server = createRpc(port2);
  const values: number[] = [];
  const callbacks = new Set<(value: number) => void>();
  try {
    client.onDidError(() => {
      throw new Error('error observer failed');
    });
    const stopErrors = client.onDidError((error) => errors.push(error));
    server.register(serviceService, {
      onDidValue(listener: (value: number) => void) {
        callbacks.add(listener);
        return () => {
          callbacks.delete(listener);
        };
      },
      run() {
        for (const listener of callbacks) listener(1);
        return 2;
      },
    });
    const proxy = client.getProxy<{
      onDidValue(listener: (value: number) => void): () => void;
      run(): number;
    }>(serviceService);
    proxy.onDidValue(() => {
      throw new Error('listener failed');
    });
    proxy.onDidValue((value) => values.push(value));
    expect(await proxy.run()).toBe(2);
    expect(values).toEqual([1]);
    expect(errors.map((error) => error.message)).toEqual(['listener failed']);
    stopErrors();
  } finally {
    client.dispose();
    server.dispose();
    port1.close();
    port2.close();
  }
});

test('physical port closure rejects requests and invokes close listeners once', async () => {
  const { port1, port2 } = new MessageChannel();
  const client = createRpc(port1, { timeoutMs: 1000 });
  const server = createRpc(port2);
  let closes = 0;
  try {
    client.onDidClose(() => {
      closes++;
    });
    server.register(serviceService, {
      run() {
        return new Promise(() => {});
      },
    });
    const proxy = client.getProxy<{ run(): Promise<void> }>(serviceService);
    const rejected = expect(proxy.run()).rejects.toMatchObject({ name: 'RpcDisconnectedError' });
    port2.close();
    await rejected;
    client.dispose();
    expect(closes).toBe(1);
    let lateClose = false;
    client.onDidClose(() => {
      lateClose = true;
    });
    expect(lateClose).toBe(true);
  } finally {
    client.dispose();
    server.dispose();
    port1.close();
    port2.close();
  }
});
