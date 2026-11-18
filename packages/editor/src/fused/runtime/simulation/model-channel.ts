/**
 * Model lane between the simulation guest and the display guest (RFC 0025).
 *
 * The host transfers one end of a `MessageChannel` to each guest, so a display input handler calls
 * its model directly instead of asking the editor to relay the call. The simulation guest serves
 * {@link fusedModelChannelService} and pushes events to the display sink only while the display is
 * subscribed to that instance and event.
 */
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { Value } from '@mica-js/document/fused';
import { fusedModelChannelService, fusedModelSinkService } from '../protocol';
import { channelKey } from '../model-events';
import type { IFusedModelEventWire } from '../protocol';

/** Guest-side capabilities the display lane reaches through this port. */
export interface IFusedModelChannelHandlers {
  /** Invokes one declared model method; failures are already encoded for the wire. */
  readonly call: (instanceId: string, method: string, params: Value) => Promise<Value>;
}

export interface IFusedSimulationModelChannel {
  /** Delivers one model event to the display guest when it subscribed to it. */
  deliver(event: IFusedModelEventWire): void;
  /** Drops every display subscription, e.g. when the session was replaced. */
  reset(): void;
  dispose(): void;
}

/** Starts the simulation end of the model lane over `port`. */
export function startSimulationModelChannel(
  port: MessagePort,
  handlers: IFusedModelChannelHandlers,
  createEndpoint: (port: MessagePort) => RpcEndpoint = createRpc,
): IFusedSimulationModelChannel {
  const endpoint = createEndpoint(port);
  const sink = endpoint.getProxy(fusedModelSinkService);
  const subscriptions = new Set<string>();
  endpoint.register(fusedModelChannelService, {
    call: handlers.call,
    subscribe(instanceId, event) {
      subscriptions.add(channelKey(instanceId, event));
    },
    unsubscribe(instanceId, event) {
      subscriptions.delete(channelKey(instanceId, event));
    },
    settle: () => undefined,
  });
  return {
    deliver(event) {
      if (!subscriptions.has(channelKey(event.instanceId, event.event))) return;
      void sink.deliver(event).catch(() => undefined);
    },
    reset() {
      subscriptions.clear();
    },
    dispose() {
      subscriptions.clear();
      endpoint.dispose();
    },
  };
}
