import { createRpc } from '@mica-js/core/rpc';
import type { SandboxWorker } from '@mica-js/sandbox';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { deviceSimulationHostFileSystemService, deviceSimulationHostGuestService } from './rpc';
import {
  createDeviceSimulationHostFromSandbox,
  type SandboxDeviceSimulationHostOptions,
} from './sandbox-host';
import type { SimulationPublish } from './types';

/** The packaged guest factory; referenced type-only so the test never bundles the guest script. */
type GuestFactory = typeof import('../sandbox').createDeviceSimulationHostGuestSandbox;

interface FakeGuest {
  readonly calls: string[];
  readonly reads: string[];
  readonly sandbox: SandboxWorker;
  readonly files: { read(uri: string): Promise<Uint8Array> };
  /** Resolves once the host subscribed to publishes. */
  readonly subscribed: Promise<void>;
  emitPublish(publish: SimulationPublish): void;
  terminated(): boolean;
}

function createFakeGuest(): FakeGuest {
  const calls: string[] = [];
  const reads: string[] = [];
  let listener: ((publish: SimulationPublish) => void) | undefined;
  let markSubscribed: () => void = () => {};
  const subscribed = new Promise<void>((resolve) => {
    markSubscribed = resolve;
  });
  let terminated = false;
  let files: FakeGuest['files'] | undefined;

  const registerGuest = (port: MessagePort): void => {
    const rpc = createRpc(port);
    rpc.register(deviceSimulationHostGuestService, {
      async loadSchematic(uri: string | undefined) {
        calls.push(`loadSchematic:${uri ?? 'none'}`);
      },
      async reset() {
        calls.push('reset');
      },
      async tick(dt: number) {
        calls.push(`tick:${dt}`);
        return { simTime: dt, executed: 1 };
      },
      async deliver(target, payload) {
        calls.push(`deliver:${target.symbol}.${target.port}:${String(payload)}`);
      },
      onDidPublish(next: (publish: SimulationPublish) => void) {
        listener = next;
        markSubscribed();
        return () => {
          listener = undefined;
        };
      },
      async getTopics() {
        return [
          {
            symbol: 'S1',
            designator: 'S1',
            port: 'state',
            direction: 'output' as const,
            type: 'string' as const,
          },
        ];
      },
      async getSimTime() {
        return 42;
      },
      async getSchematic() {
        return undefined;
      },
      async dispose() {
        calls.push('dispose');
      },
    });

    files = rpc.getProxy(deviceSimulationHostFileSystemService);
  };

  const sandbox = {
    ready: Promise.resolve(),
    postMessage(_message: unknown, transfer?: readonly Transferable[]): void {
      const port = transfer?.[0];
      if (!(port instanceof MessagePort)) throw new Error('missing RPC port');
      registerGuest(port);
    },
    async terminate(): Promise<void> {
      terminated = true;
    },
  };

  return {
    calls,
    reads,
    sandbox: sandbox as unknown as SandboxWorker,
    get files() {
      return files!;
    },
    subscribed,
    emitPublish(publish) {
      listener?.(publish);
    },
    terminated: () => terminated,
  };
}

describe('createDeviceSimulationHostFromSandbox', () => {
  it('accepts the packaged guest factory, whose workers satisfy SandboxWorker', () => {
    expectTypeOf<GuestFactory>().toBeCallableWith();
    expectTypeOf<GuestFactory>().toBeCallableWith({ name: 'test' });
    expectTypeOf<ReturnType<GuestFactory>>().toExtend<SandboxWorker>();
    expectTypeOf<Parameters<typeof createDeviceSimulationHostFromSandbox>>().toEqualTypeOf<
      [SandboxDeviceSimulationHostOptions]
    >();
    expectTypeOf<SandboxDeviceSimulationHostOptions>().toHaveProperty('sandbox');
    expectTypeOf<SandboxDeviceSimulationHostOptions['sandbox']>().toEqualTypeOf<SandboxWorker>();
  });

  it('proxies the typed host contract over one MessagePort', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fake = createFakeGuest();
    const host = await createDeviceSimulationHostFromSandbox({
      sandbox: fake.sandbox,
      fs: {
        async read(uri) {
          fake.reads.push(uri);
          return bytes;
        },
      },
    });
    try {
      const read = await fake.files.read('file:///demo.sch');
      expect([...read]).toEqual([1, 2, 3]);
      expect(fake.reads).toEqual(['file:///demo.sch']);

      await host.loadSchematic('file:///demo.sch');
      expect(fake.calls).toEqual(['loadSchematic:file:///demo.sch']);
      expect(await host.tick(10_000)).toEqual({ simTime: 10_000, executed: 1 });
      await host.deliver({ symbol: 'S1', port: 'pressed' }, true);
      expect(fake.calls.slice(-2)).toEqual(['tick:10000', 'deliver:S1.pressed:true']);
      expect(await host.getTopics()).toEqual([
        {
          symbol: 'S1',
          designator: 'S1',
          port: 'state',
          direction: 'output',
          type: 'string',
        },
      ]);
      expect(await host.getSimTime()).toBe(42);
      expect(await host.getSchematic()).toBeUndefined();
      await host.reset();
      expect(fake.calls.at(-1)).toBe('reset');
    } finally {
      await host.dispose();
    }
    expect(fake.calls.at(-1)).toBe('dispose');
    expect(fake.terminated()).toBe(true);
  });

  it('subscribes to guest publishes through the onDidPublish convention', async () => {
    const fake = createFakeGuest();
    const host = await createDeviceSimulationHostFromSandbox({
      sandbox: fake.sandbox,
      fs: { read: async () => new Uint8Array() },
    });
    try {
      const publish: SimulationPublish = {
        target: { symbol: 'S1', port: 'state' },
        payload: 'CLOSED',
        simTime: 10,
      };
      const received = new Promise<SimulationPublish>((resolve) => {
        host.onDidPublish(resolve);
      });
      await fake.subscribed;
      fake.emitPublish(publish);
      expect(await received).toEqual(publish);
    } finally {
      await host.dispose();
    }
  });
});
