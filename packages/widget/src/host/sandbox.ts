import { createRpc } from '@mica-js/core/rpc';
import { loggerService } from '@mica-js/core/logging';
import { isHostFsError, toHostFsErrorPayload } from '../host-fs/errors';
import { widgetAudioGuestService } from '../guest/audio/protocol';
import {
  widgetGuestControlService,
  widgetGuestService,
  widgetHostCapabilitiesService,
  widgetHostControlService,
} from '../guest/widget/protocol';
import type { SandboxWorker } from '@mica-js/sandbox';
import type { WidgetSandbox, WidgetSandboxHostOptions } from './types';

/** Adapts a provider-created widget worker to WidgetHost's RPC-facing surface. */
export async function createWidgetSandboxFromWorker(
  worker: SandboxWorker,
  options: WidgetSandboxHostOptions,
): Promise<WidgetSandbox> {
  const devicePort = options.devicePort;
  let port: MessagePort;
  let rpc: ReturnType<typeof createRpc> | undefined;
  let logRegistration: { dispose(): void } | undefined;
  try {
    await worker.ready;
    const channel = new MessageChannel();
    port = channel.port1;
    const endpoint = createRpc(port);
    rpc = endpoint;
    logRegistration = endpoint.register(loggerService, {
      write(record) {
        const method = console[record.level] ?? console.log;
        method.call(console, `[${record.scope}]`, record.message, ...record.data);
      },
    });
    const transfer = devicePort === undefined ? [channel.port2] : [channel.port2, devicePort];
    worker.postMessage(null, transfer);
  } catch (error) {
    logRegistration?.dispose();
    rpc?.dispose();
    await worker.terminate('widget sandbox failed to start').catch(() => undefined);
    throw error;
  }
  const endpoint = rpc;
  if (endpoint === undefined) {
    throw new Error('Widget RPC endpoint was not created.');
  }
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const dispatch = (type: string, payload: unknown) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(payload);
  };
  endpoint.register(
    widgetHostCapabilitiesService,
    {
      async read(uri: string) {
        if (!options.fs) throw new Error(`No HostFs configured for ${uri}`);
        try {
          return await options.fs.read(uri);
        } catch (error) {
          if (isHostFsError(error)) {
            const payload = toHostFsErrorPayload(error);
            throw Object.assign(new Error(JSON.stringify(payload)), { name: 'HostFsError' });
          }
          throw error;
        }
      },
    },
    {
      transfer: (member, value) =>
        member === 'read' && value instanceof Uint8Array ? [value.buffer] : [],
    },
  );
  endpoint.register(widgetHostControlService, { event: dispatch });
  const guest = endpoint.getProxy(widgetGuestService) as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const audio = endpoint.getProxy(widgetAudioGuestService, {
    transfer: (member, args) => (member === 'attachPort' ? [args[0] as MessagePort] : []),
  });
  return {
    get state() {
      return worker.state;
    },
    directDevice: devicePort !== undefined,
    call: (method, ...args) => guest[method]!(...args),
    on: (type, listener) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => set?.delete(listener);
    },
    emit: (type, payload, transfer) => {
      void endpoint
        .getProxy(widgetGuestControlService, { transfer: () => transfer ?? [] })
        .dispatchEvent(type, payload)
        .catch(() => undefined);
    },
    audio: {
      attachPort: (port) => {
        void audio.attachPort(port).catch(() => undefined);
      },
      setState: (state) => {
        void audio.setState(state).catch(() => undefined);
      },
    },
    terminate: async (reason) => {
      logRegistration?.dispose();
      endpoint.dispose();
      await worker.terminate(reason);
    },
  } satisfies WidgetSandbox;
}
