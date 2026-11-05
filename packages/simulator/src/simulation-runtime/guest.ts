import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import { copyBytePayload } from './payload';
import {
  simulationRuntimeEventTransfer,
  simulationRuntimeService,
  simulationRuntimeTopicService,
} from './rpc';
import type { ISimulationRuntimeRpc, ISimulationRuntimeTopicRpc } from './rpc';
import { createSimulationRuntime } from './runtime';
import type {
  ISimulationMessage,
  ISimulationRuntime,
  SimulationModuleImporter,
  ISimulationRuntimeOptions,
} from './types';

/** Startup options of the in-process runtime guest; none of them travel over RPC. */
export interface ISimulationRuntimeGuestOptions {
  readonly importer?: SimulationModuleImporter;
  /** Extra ports the worker received; the first one is the direct topic channel. */
  readonly ports?: readonly MessagePort[];
}

/** Running runtime guest: where the typed service lives and which ports it owns. */
export interface ISimulationRuntimeGuest {
  readonly rpc: RpcEndpoint;
  readonly ports: readonly MessagePort[];
  readonly runtime: ISimulationRuntime;
  dispose(): Promise<void>;
}

/** Registrations that put one runtime on an existing endpoint and its topic port. */
export interface IRegisteredSimulationRuntime {
  dispose(): void;
}

/**
 * Registers the prepared simulation runtime as `simulation-runtime` on an existing endpoint.
 *
 * The primary endpoint gets the full control surface and diagnostics; `topicRpc`, when present,
 * gets `deliver` plus `onDidPublish` only, so a widget guest talks to the simulation directly.
 * Both registrations share the one runtime instance and are released together. The caller owns
 * `rpc` and `topicRpc`; this function only owns the registrations it creates.
 */
export function registerSimulationRuntimeServices(
  rpc: RpcEndpoint,
  runtime: ISimulationRuntime,
  topicRpc?: RpcEndpoint,
): IRegisteredSimulationRuntime {
  const service = createRuntimeService(runtime);
  const serviceRegistration = rpc.register(simulationRuntimeService, service, {
    transfer: simulationRuntimeEventTransfer,
  });
  const topicRegistration =
    topicRpc === undefined
      ? undefined
      : topicRpc.register(
          simulationRuntimeTopicService,
          {
            deliver: service.deliver,
            onDidPublish: service.onDidPublish,
          },
          { transfer: simulationRuntimeEventTransfer },
        );

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        topicRegistration?.dispose();
      } finally {
        serviceRegistration.dispose();
      }
    },
  };
}

/**
 * Starts the prepared simulation runtime on one sandbox RPC port.
 *
 * A worker script calls this after taking `event.ports[0]`; extra ports stay in order. The returned
 * node owns the runtime and disposes it with the registrations.
 */
export function startSimulationRuntimeGuest(
  port: MessagePort,
  options: ISimulationRuntimeGuestOptions = {},
): ISimulationRuntimeGuest {
  const rpc = createRpc(port);
  const runtime = createSimulationRuntime(runtimeOptions(options));
  const ports = options.ports ?? [];
  const topicPort = ports[0];
  const topicRpc = topicPort === undefined ? undefined : createRpc(topicPort);
  const registered = registerSimulationRuntimeServices(rpc, runtime, topicRpc);
  let disposed = false;
  return {
    rpc,
    ports,
    runtime,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        registered.dispose();
        await runtime.dispose();
      } finally {
        topicRpc?.dispose();
        rpc.dispose();
        port.close();
        for (const extra of ports) extra.close();
      }
    },
  };
}

function runtimeOptions(options: ISimulationRuntimeGuestOptions): ISimulationRuntimeOptions {
  return {
    ...(options.importer === undefined ? {} : { importer: options.importer }),
  };
}

function createRuntimeService(runtime: ISimulationRuntime): ISimulationRuntimeRpc {
  const onDidPublish: ISimulationRuntimeTopicRpc['onDidPublish'] = (listener) => {
    const subscription = runtime.onDidPublish((message) => listener(copyMessage(message)));
    return () => subscription.dispose();
  };
  return {
    load: (input) => runtime.load(input),
    reset: () => runtime.reset(),
    tick: (dt) => runtime.tick(dt),
    deliver: (message) => runtime.deliver(message),
    onDidPublish,
    onDidDiagnostic(listener) {
      const subscription = runtime.onDidDiagnostic(listener);
      return () => subscription.dispose();
    },
    dispose: () => runtime.dispose(),
  };
}

function copyMessage(message: ISimulationMessage): ISimulationMessage {
  const payload = copyBytePayload(message.payload);
  return payload === message.payload ? message : { ...message, payload };
}
