/**
 * Local fan-out of model events (RFC 0021).
 *
 * The host and the display guest both expose `Event<ModelEvent<T>>` outlets whose subscriptions are
 * lazy: the first listener of one instance and event subscribes on the wire, the last one
 * unsubscribes, and a released instance drops every local listener.
 */
import { Emitter, toDisposable } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import type { Value } from '@mica-js/document/fused';
import type { ModelEvent } from '@mica-js/sdk/fused';

/** Wire subscriptions the router needs from its owner. */
export interface IFusedModelEventChannel {
  subscribe(instanceId: string, event: string): void;
  unsubscribe(instanceId: string, event: string): void;
}

export interface IFusedModelEventRouter {
  /** Declared event outlet of one instance; only listeners create a wire subscription. */
  event(instanceId: string, event: string): Event<ModelEvent<Value>>;
  /** Delivers one event to the listeners active at this moment. */
  deliver(instanceId: string, event: string, payload: ModelEvent<Value>): void;
  /** Drops every listener of one instance. */
  release(instanceId: string): void;
  dispose(): void;
  /** Number of live wire subscriptions; used to keep the wire silent without listeners. */
  readonly activeSubscriptions: number;
}

export function channelKey(instanceId: string, event: string): string {
  return `${instanceId}\u0000${event}`;
}

export function createModelEventRouter(channel: IFusedModelEventChannel): IFusedModelEventRouter {
  const entries = new Map<string, { emitter: Emitter<ModelEvent<Value>>; listeners: number }>();

  const event = (instanceId: string, name: string): Event<ModelEvent<Value>> => {
    const key = channelKey(instanceId, name);
    return (listener) => {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = { emitter: new Emitter<ModelEvent<Value>>(), listeners: 0 };
        entries.set(key, entry);
      }
      const current = entry;
      current.listeners += 1;
      if (current.listeners === 1) channel.subscribe(instanceId, name);
      const subscription = current.emitter.event(listener);
      return toDisposable(() => {
        subscription.dispose();
        current.listeners -= 1;
        if (current.listeners > 0) return;
        entries.delete(key);
        current.emitter.dispose();
        channel.unsubscribe(instanceId, name);
      });
    };
  };

  const drop = (key: string, instanceId: string, name: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    entry.emitter.dispose();
    channel.unsubscribe(instanceId, name);
  };

  return {
    event,
    deliver(instanceId, name, payload) {
      entries.get(channelKey(instanceId, name))?.emitter.fire(payload);
    },
    release(instanceId) {
      const prefix = `${instanceId}\u0000`;
      for (const key of [...entries.keys()]) {
        if (!key.startsWith(prefix)) continue;
        drop(key, instanceId, key.slice(prefix.length));
      }
    },
    dispose() {
      for (const key of [...entries.keys()]) {
        const separator = key.indexOf('\u0000');
        drop(key, key.slice(0, separator), key.slice(separator + 1));
      }
    },
    get activeSubscriptions() {
      return entries.size;
    },
  };
}
