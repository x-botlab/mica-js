import { timePs } from '@mica-js/core';
import { createRpc } from '@mica-js/core/rpc';
import type { SandboxWorker } from '@mica-js/sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSimulationRuntimeFromWorker } from './adapter';
import { startSimulationRuntimeGuest } from './guest';
import { simulationRuntimeService, simulationRuntimeTopicService } from './rpc';
import type { ISimulationMessage } from './types';
import { SYMBOL, PANEL_BYTES, importer, message, toggleSimulation } from './test-helpers';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.restoreAllMocks();
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function channelPair(): { guest: MessageChannel; host: MessageChannel } {
  const guest = new MessageChannel();
  const host = new MessageChannel();
  cleanups.push(() => {
    guest.port1.close();
    guest.port2.close();
    host.port1.close();
    host.port2.close();
  });
  return { guest, host };
}

describe('simulation runtime RPC guest', () => {
  it('serves the typed service and the direct topic subscription on one runtime', async () => {
    const primary = channelPair();
    const topic = channelPair();
    const guest = startSimulationRuntimeGuest(primary.guest.port2, {
      importer,
      ports: [topic.guest.port2],
    });
    cleanups.push(() => guest.dispose());
    const primaryRpc = createRpc(primary.guest.port1);
    const topicRpc = createRpc(topic.guest.port1);
    cleanups.push(() => primaryRpc.dispose());
    cleanups.push(() => topicRpc.dispose());
    const api = primaryRpc.getProxy(simulationRuntimeService);
    const topicApi = topicRpc.getProxy(simulationRuntimeTopicService);

    const primaryPublishes: ISimulationMessage[] = [];
    const topicPublishes: ISimulationMessage[] = [];
    const primarySubscription = api.onDidPublish((publish) => primaryPublishes.push(publish));
    const topicSubscription = topicApi.onDidPublish((publish) => topicPublishes.push(publish));
    cleanups.push(() => primarySubscription());
    cleanups.push(() => topicSubscription());

    await api.load(toggleSimulation());
    await api.tick(timePs(10_000));
    await waitFor(() => primaryPublishes.length === 5 && topicPublishes.length === 5);
    expect(topicPublishes.map((publish) => publish.target.port)).toEqual(
      primaryPublishes.map((publish) => publish.target.port),
    );
    expect(primaryPublishes.at(-1)).toMatchObject({
      target: { symbol: SYMBOL, port: 'blob' },
      payload: new Uint8Array([1, 2, 3]),
      simTime: 10_000,
    });

    await topicApi.deliver(message(SYMBOL, 'lamp', true));
    primaryPublishes.length = 0;
    topicPublishes.length = 0;
    await api.tick(timePs(10_000));
    await waitFor(
      () =>
        primaryPublishes.some((publish) => publish.target.port === 'state') &&
        topicPublishes.some((publish) => publish.target.port === 'state'),
    );
    expect(primaryPublishes.find((publish) => publish.target.port === 'state')?.payload).toBe(true);
    expect(topicPublishes.some((publish) => publish.target.port === 'state')).toBe(true);

    topicSubscription();
    primaryPublishes.length = 0;
    topicPublishes.length = 0;
    await topicApi.deliver(message(SYMBOL, 'lamp', false));
    await api.tick(timePs(10_000));
    await waitFor(() => primaryPublishes.some((publish) => publish.target.port === 'state'));
    expect(primaryPublishes.find((publish) => publish.target.port === 'state')?.payload).toBe(
      false,
    );
    expect(topicPublishes).toEqual([]);

    let rpcClosed = false;
    guest.rpc.onDidClose(() => {
      rpcClosed = true;
    });
    await guest.dispose();
    expect(rpcClosed).toBe(true);
    await expect(guest.runtime.tick(timePs(1_000))).rejects.toMatchObject({ code: 'disposed' });
  });

  it('transfers byte payloads without detaching the caller buffer', async () => {
    const primary = channelPair();
    const guest = startSimulationRuntimeGuest(primary.guest.port2, {
      importer,
    });
    cleanups.push(() => guest.dispose());
    const primaryRpc = createRpc(primary.guest.port1);
    cleanups.push(() => primaryRpc.dispose());
    const api = primaryRpc.getProxy(simulationRuntimeService);
    const publishes: ISimulationMessage[] = [];
    const subscription = api.onDidPublish((publish) => publishes.push(publish));
    cleanups.push(() => subscription());

    await api.load(toggleSimulation());
    await api.tick(timePs(1_000));
    await waitFor(() => publishes.length === 5);
    publishes.length = 0;

    const frame = new Uint8Array([9, 8, 7, 6]);
    await api.deliver(message(SYMBOL, 'frame', frame));
    await api.tick(timePs(1_000));
    await waitFor(() => publishes.some((publish) => publish.target.port === 'frameLength'));
    expect(frame.byteLength).toBe(4);
    expect(publishes.find((publish) => publish.target.port === 'frameLength')?.payload).toBe(4);
    expect(publishes.find((publish) => publish.target.port === 'blob')?.payload).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});

describe('createSimulationRuntimeFromWorker', () => {
  interface FakeWorker {
    readonly worker: SandboxWorker;
    readonly terminate: ReturnType<typeof vi.fn>;
  }

  function createFakeWorker(): FakeWorker {
    let guest: ReturnType<typeof startSimulationRuntimeGuest> | undefined;
    const terminate = vi.fn(async () => {
      await guest?.dispose();
    });
    const worker = {
      ready: Promise.resolve(),
      postMessage(_message: unknown, options?: readonly Transferable[]): void {
        const ports = Array.isArray(options) ? options : [];
        const rpcPort = ports[0];
        if (!(rpcPort instanceof MessagePort)) throw new Error('missing RPC port');
        const extra = ports
          .slice(1)
          .filter((port): port is MessagePort => port instanceof MessagePort);
        guest = startSimulationRuntimeGuest(rpcPort, {
          importer,
          ports: extra,
        });
      },
      terminate,
    } as unknown as SandboxWorker;
    return { worker, terminate };
  }

  it('drives the worker guest and terminates it on dispose', async () => {
    const fake = createFakeWorker();
    const topic = channelPair();
    const runtime = await createSimulationRuntimeFromWorker(fake.worker, {
      topicPort: topic.guest.port2,
    });
    cleanups.push(() => runtime.dispose());
    const topicRpc = createRpc(topic.guest.port1);
    cleanups.push(() => topicRpc.dispose());
    const topicApi = topicRpc.getProxy(simulationRuntimeTopicService);

    const publishes: ISimulationMessage[] = [];
    const topicPublishes: ISimulationMessage[] = [];
    const subscription = runtime.onDidPublish((publish) => publishes.push(publish));
    const topicSubscription = topicApi.onDidPublish((publish) => topicPublishes.push(publish));
    cleanups.push(() => subscription.dispose());
    cleanups.push(() => topicSubscription());

    await runtime.load(toggleSimulation());
    expect(PANEL_BYTES.byteLength).toBe(3);
    expect(await runtime.tick(timePs(10_000))).toEqual({ simTime: 10_000, executed: 1 });
    await waitFor(() => publishes.length === 5 && topicPublishes.length === 5);
    const frame = new Uint8Array([1, 2, 3, 4, 5]);
    await runtime.deliver(message(SYMBOL, 'frame', frame));
    publishes.length = 0;
    await runtime.tick(timePs(10_000));
    await waitFor(() => publishes.some((publish) => publish.target.port === 'frameLength'));
    expect(frame.byteLength).toBe(5);
    expect(publishes.find((publish) => publish.target.port === 'frameLength')?.payload).toBe(5);

    await runtime.dispose();
    expect(fake.terminate).toHaveBeenCalledWith('disposed');
    await expect(runtime.tick(timePs(1_000))).rejects.toBeInstanceOf(Error);
  });

  it('terminates the worker when startup fails', async () => {
    const terminate = vi.fn(async () => undefined);
    const worker = {
      ready: Promise.reject(new Error('boot failed')),
      terminate,
    } as unknown as SandboxWorker;
    const topic = channelPair();
    await expect(
      createSimulationRuntimeFromWorker(worker, { topicPort: topic.guest.port2 }),
    ).rejects.toThrow('boot failed');
    expect(terminate).toHaveBeenCalled();
  });
});
