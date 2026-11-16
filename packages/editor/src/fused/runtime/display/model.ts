/**
 * Display-side model client of one instance (RFC 0021 / RFC 0022).
 *
 * The client talks to the simulation guest over the direct model lane: a presentation input handler
 * calls its model without a hop through the editor, and `invalidate()` remains the only repaint
 * trigger. Only the methods and events the manifest declares resolve.
 */
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { Event } from '@mica-js/core/lifecycle';
import type { Value } from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';
import { createModelEventRouter } from '../model-events';
import { fusedModelChannelService, fusedModelSinkService } from '../protocol';
import type {
  IFusedInstancePresentation,
  IFusedModelClient,
  FusedModelMethods,
  IFusedModelEventWire,
} from '../protocol';
import { mapWireFailure } from '../wire';

/** Model lane as the display guest sees it. */
export interface IFusedDisplayModelChannel {
  /** Model client of one prepared instance. */
  client(instance: IFusedInstancePresentation): IFusedModelClient;
  /** Drops every listener of a released instance. */
  release(instanceId: string): void;
  /**
   * Resolves once every subscription started so far reached the simulation guest.
   *
   * Preparation awaits this before the models are mounted, so an event produced while a model
   * initializes is never lost to a subscription that is still in flight.
   */
  settle(): Promise<void>;
  dispose(): void;
}

/** Starts the display end of the model lane over `port`. */
export function startDisplayModelChannel(
  port: MessagePort,
  createEndpoint: (port: MessagePort) => RpcEndpoint = createRpc,
): IFusedDisplayModelChannel {
  const endpoint = createEndpoint(port);
  const lane = endpoint.getProxy(fusedModelChannelService);
  /** Wire subscriptions still in flight, so preparation can wait for the model lane to catch up. */
  const inFlight = new Set<Promise<void>>();
  const router = createModelEventRouter({
    subscribe(instanceId, event) {
      const call = lane.subscribe(instanceId, event).catch(() => undefined);
      inFlight.add(call);
      void call.finally(() => inFlight.delete(call));
    },
    unsubscribe(instanceId, event) {
      const call = lane.unsubscribe(instanceId, event).catch(() => undefined);
      inFlight.add(call);
      void call.finally(() => inFlight.delete(call));
    },
  });
  endpoint.register(fusedModelSinkService, {
    deliver(event: IFusedModelEventWire) {
      if (!isModelEvent(event)) return;
      router.deliver(event.instanceId, event.event, event.payload);
    },
  });
  return {
    client(instance) {
      const declared = new Set(instance.methods);
      const methods = new Proxy(Object.create(null) as Record<string, unknown>, {
        get(_target, name) {
          if (typeof name !== 'string' || !declared.has(name)) return undefined;
          return (params: Value) =>
            mapWireFailure(() => lane.call(instance.instanceId, name, params));
        },
        has(_target, name) {
          return typeof name === 'string' && declared.has(name);
        },
      }) as FusedModelMethods;
      const events: Record<string, Event<ModelEvent<Value>>> = {};
      for (const name of instance.events) {
        events[name] = router.event(instance.instanceId, name);
      }
      return { methods, events };
    },
    release(instanceId) {
      router.release(instanceId);
    },
    async settle() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    dispose() {
      router.dispose();
      endpoint.dispose();
    },
  };
}

function isModelEvent(value: unknown): value is IFusedModelEventWire {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly instanceId?: unknown; readonly event?: unknown };
  return typeof candidate.instanceId === 'string' && typeof candidate.event === 'string';
}
