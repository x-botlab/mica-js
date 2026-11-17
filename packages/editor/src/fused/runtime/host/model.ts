/**
 * Host-side model clients of the fused runtime (RFC 0021).
 *
 * The editor calls a model through the simulation worker, never in its own thread. Event outlets are
 * lazy: one wire listener serves every local subscription and is released with the last of them.
 */
import type { Event } from '@mica-js/core/lifecycle';
import type { RpcProxy } from '@mica-js/core/rpc';
import type { Value } from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';
import { createModelEventRouter } from '../model-events';
import type { IFusedModelEventRouter } from '../model-events';
import type {
  IFusedInstancePresentation,
  IFusedModelClient,
  FusedModelMethods,
  IFusedSimulationService,
} from '../protocol';
import { FusedBridgeError, mapWireFailure } from '../wire';

/** Model clients of one runtime, keyed by the instance they belong to. */
export interface IFusedHostModelRouter {
  client(instance: IFusedInstancePresentation): IFusedModelClient;
  release(instanceId: string): void;
  dispose(): void;
}

export function createHostModelRouter(
  proxy: RpcProxy<IFusedSimulationService>,
): IFusedHostModelRouter {
  let router: IFusedModelEventRouter | undefined;
  let subscriptions = 0;
  let stop: (() => void) | undefined;
  router = createModelEventRouter({
    subscribe() {
      subscriptions += 1;
      if (subscriptions > 1 || stop !== undefined) return;
      stop = proxy.onDidModelEvent((event) => {
        router?.deliver(event.instanceId, event.event, event.payload);
      });
    },
    unsubscribe() {
      subscriptions = Math.max(0, subscriptions - 1);
      if (subscriptions > 0) return;
      stop?.();
      stop = undefined;
    },
  });

  const active = (): IFusedModelEventRouter => {
    if (router === undefined) {
      throw new Error('The fused model router is disposed.');
    }
    return router;
  };

  const invoke = (instanceId: string, method: string, params: Value): Promise<Value> => {
    if (router === undefined) {
      return Promise.reject(
        new FusedBridgeError(
          'model/disconnected',
          'The model client is disconnected from any live model.',
          { instanceId },
        ),
      );
    }
    return mapWireFailure(() => proxy.call(instanceId, method, params));
  };
  return {
    client(instance) {
      const declared = new Set(instance.methods);
      const methods = new Proxy(Object.create(null) as Record<string, unknown>, {
        get(_target, name) {
          if (typeof name !== 'string' || !declared.has(name)) return undefined;
          return (params: Value) => invoke(instance.instanceId, name, params);
        },
        has(_target, name) {
          return typeof name === 'string' && declared.has(name);
        },
      }) as FusedModelMethods;
      const events: Record<string, Event<ModelEvent<Value>>> = {};
      for (const name of instance.events) {
        events[name] = active().event(instance.instanceId, name);
      }
      return { methods, events };
    },
    release(instanceId) {
      router?.release(instanceId);
    },
    dispose() {
      stop?.();
      stop = undefined;
      router?.dispose();
      router = undefined;
    },
  };
}
