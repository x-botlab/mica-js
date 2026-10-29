/// <reference types="node" />
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { test } from 'vitest';
import { createRpc } from './rpc';
import { sharedService } from './test-helpers';

const deviceService = sharedService('device');
const callbackService = sharedService('callback');
const serviceService = sharedService('service');
const blockedService = sharedService('blocked');

type Publication = { simTime: number; payload: Uint8Array };
interface DeviceHost {
  tick(dt: number): Promise<number>;
  onDidPublishTopic(listener: (message: Publication) => void): () => void;
}

class Device {
  time = 0;
  listeners = new Set<(message: Publication) => void>();
  async tick(dt: number): Promise<number> {
    this.time += dt;
    for (const listener of this.listeners) {
      listener({ simTime: this.time, payload: new Uint8Array([this.time]) });
    }
    return this.time;
  }
  onDidPublishTopic(listener: (message: Publication) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function pair() {
  const { port1, port2 } = new MessageChannel();
  const errors: unknown[] = [];
  const client = createRpc(port1, { onError: (error) => errors.push(error) });
  const server = createRpc(port2, { onError: (error) => errors.push(error) });
  return {
    client,
    server,
    errors,
    close() {
      client.dispose();
      server.dispose();
      port1.close();
      port2.close();
    },
  };
}

test('class methods retain this; events arrive before tick resolves; unsubscribe works', async () => {
  const rpc = pair();
  try {
    const device = new Device();
    rpc.server.register(deviceService, device);
    const proxy = rpc.client.getProxy<DeviceHost>(deviceService);
    const messages: Publication[] = [];
    const stop = proxy.onDidPublishTopic((message) => messages.push(message));
    assert.equal(await proxy.tick(3), 3);
    assert.deepEqual(messages, [{ simTime: 3, payload: new Uint8Array([3]) }]);
    stop();
    stop();
    assert.equal(await proxy.tick(5), 8);
    assert.equal(messages.length, 1);
    assert.equal(device.listeners.size, 0);
    assert.equal(await Promise.resolve(proxy), proxy);
    assert.deepEqual(rpc.errors, []);
  } finally {
    rpc.close();
  }
});

test('missing methods, services and prototype/accessor members reject', async () => {
  const rpc = pair();
  try {
    let getterCalls = 0;
    rpc.server.register(serviceService, {
      get secret() {
        getterCalls++;
        return () => 1;
      },
    });
    const proxy = rpc.client.getProxy<Record<string, () => Promise<unknown>>>(serviceService);
    for (const name of ['missing', 'constructor', '__proto__', 'toString', 'secret']) {
      await assert.rejects(proxy[name]!(), { name: 'MethodNotFound' });
    }
    assert.equal(getterCalls, 0);
    const missing = rpc.client.getProxy<{ run(): Promise<void> }>(sharedService('missing'));
    await assert.rejects(missing.run(), { name: 'ServiceNotFound' });
  } finally {
    rpc.close();
  }
});

test('remote errors and unclonable results reject without breaking later calls', async () => {
  const rpc = pair();
  try {
    rpc.server.register(serviceService, {
      fail() {
        throw Object.assign(new Error('bad input'), { name: 'InvalidInput' });
      },
      unclonable() {
        return () => undefined;
      },
      ok() {
        return 42;
      },
    });
    const proxy = rpc.client.getProxy<Record<string, () => Promise<unknown>>>(serviceService);
    await assert.rejects(proxy.fail!(), { name: 'InvalidInput', message: 'bad input' });
    await assert.rejects(proxy.unclonable!(), { name: 'DataCloneError' });
    assert.equal(await proxy.ok!(), 42);
  } finally {
    rpc.close();
  }
});

test('subscription errors are reported and immediate cancellation cleans up', async () => {
  const rpc = pair();
  try {
    const device = new Device();
    rpc.server.register(deviceService, device);
    const proxy = rpc.client.getProxy<
      DeviceHost & { onDidMissing(listener: () => void): () => void }
    >(deviceService);
    proxy.onDidMissing(() => undefined);
    const stop = proxy.onDidPublishTopic(() => assert.fail('cancelled listener ran'));
    stop();
    await proxy.tick(1);
    assert.equal(device.listeners.size, 0);
    assert.equal((rpc.errors[0] as Error).name, 'MethodNotFound');
  } finally {
    rpc.close();
  }
});

test('bidirectional calls support reentrancy and correlate concurrent replies', async () => {
  const rpc = pair();
  try {
    rpc.client.register(callbackService, {
      double(value: number) {
        return value * 2;
      },
    });
    const callback = rpc.server.getProxy<{ double(value: number): Promise<number> }>(
      callbackService,
    );
    rpc.server.register(serviceService, {
      async run(value: number) {
        return await callback.double(value);
      },
    });
    const proxy = rpc.client.getProxy<{ run(value: number): Promise<number> }>(serviceService);
    assert.deepEqual(await Promise.all([proxy.run(2), proxy.run(5)]), [4, 10]);
  } finally {
    rpc.close();
  }
});

test('disconnect rejects pending and subsequent calls and releases subscriptions', async () => {
  const rpc = pair();
  try {
    const device = new Device();
    rpc.server.register(deviceService, device);
    rpc.server.register(blockedService, {
      wait() {
        return new Promise(() => undefined);
      },
    });
    const proxy = rpc.client.getProxy<DeviceHost>(deviceService);
    proxy.onDidPublishTopic(() => undefined);
    await proxy.tick(1);
    const blocked = rpc.client.getProxy<{ wait(): Promise<void> }>(blockedService);
    const rejected = assert.rejects(blocked.wait(), { name: 'RpcDisconnectedError' });
    rpc.server.dispose();
    await rejected;
    await assert.rejects(proxy.tick(1), { name: 'RpcDisconnectedError' });
    assert.equal(device.listeners.size, 0);
  } finally {
    rpc.close();
  }
});
