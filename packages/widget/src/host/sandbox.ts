import { createRpc, defineRpcService } from '@mica-js/core/rpc';
import { WIDGET_RUNTIME_SOURCE } from '../internal/runtime-source';
import type { WidgetSandbox, WidgetSandboxFactory } from './types';

type DynamicRpcService = Record<string, (...args: never[]) => unknown>;

const guestService = defineRpcService<DynamicRpcService>('guest');
const hostCapabilitiesService = defineRpcService<DynamicRpcService>('host-capabilities');
const hostControlService = defineRpcService<{
  ready(info: unknown): void;
  bootError(error: unknown): void;
  guestError(error: unknown): void;
  log(level: string, parts: unknown[]): void;
  event(type: string, payload: unknown): void;
}>('host-control');
const guestControlService = defineRpcService<{
  dispatchEvent(type: string, payload: unknown): void;
  terminate(): void;
}>('guest-control');

/** Default sandbox over `@mica-js/sandbox`; RPC is owned by this adapter. */
export const createDefaultWidgetSandbox: WidgetSandboxFactory = async (options) => {
  const { SandboxWorker } = await import('@mica-js/sandbox');
  const worker = new SandboxWorker(
    { type: 'module', code: WIDGET_RUNTIME_SOURCE },
    {
      name: 'mica-widget-runtime',
      captureConsole: false,
      ...(options.container === undefined ? {} : { container: options.container }),
    },
  );
  const port = await worker.ready;
  const rpc = createRpc(port);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const dispatch = (type: string, payload: unknown) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(payload);
  };
  rpc.register(hostCapabilitiesService, {});
  rpc.register(hostControlService, {
    ready: () => undefined,
    bootError: (error) => dispatch('error', error),
    guestError: (error) => dispatch('error', error),
    log: (level, parts) => dispatch('log', { level, parts }),
    event: dispatch,
  });
  const guest = rpc.getProxy(guestService);

  return {
    get state() {
      return worker.state;
    },
    call: (method, ...args) =>
      (guest[method] as (...callArgs: unknown[]) => Promise<unknown>)(...args),
    on: (type, listener) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => set?.delete(listener);
    },
    emit: (type, payload, transfer) => {
      void (rpc
        .getProxy(guestControlService, { transfer: () => transfer ?? [] })
        .dispatchEvent(type, payload) as Promise<unknown>);
    },
    terminate: async (reason) => {
      rpc.dispose();
      await worker.terminate(reason);
    },
  } satisfies WidgetSandbox;
};
