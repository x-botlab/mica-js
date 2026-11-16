import type { Event } from '@mica-js/sdk/device';
import type { ModelEvent, RuntimeModelClient } from '@mica-js/sdk/fused';

type Reserved = 'methods' | 'events' | 'then';

export type DeviceFacade<M extends object, E extends object> = {
  readonly methods: Readonly<M>;
  readonly events: Readonly<E>;
} & Readonly<Pick<M, Exclude<keyof M, keyof E | Reserved>>> &
  Readonly<Pick<E, Exclude<keyof E, keyof M | Reserved>>>;

export function deviceFacade<M extends object, E extends object>(
  methods: M,
  events: E,
): DeviceFacade<M, E> {
  const flat: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(methods)) {
    if (!Object.hasOwn(events, key) && !['methods', 'events', 'then'].includes(key))
      flat[key] = value;
  }
  for (const [key, value] of Object.entries(events)) {
    if (!Object.hasOwn(methods, key) && !['methods', 'events', 'then'].includes(key))
      flat[key] = value;
  }
  // The key filtering above implements the same exclusions as DeviceFacade.
  return Object.freeze({
    ...flat,
    methods: Object.freeze(methods),
    events: Object.freeze(events),
  }) as DeviceFacade<M, E>;
}

export function modelMethod(client: RuntimeModelClient, name: string) {
  const method = client.methods[name];
  if (method === undefined) throw new Error(`Model method ${name} is unavailable`);
  return method;
}

export function modelEvent<T>(
  client: RuntimeModelClient,
  name: string,
  decode: (value: unknown) => T,
): Event<ModelEvent<T>> {
  const event = client.events[name];
  if (event === undefined) throw new Error(`Model event ${name} is unavailable`);
  return (listener, thisArgs, disposables) =>
    event(
      (entry) => listener.call(thisArgs, { ...entry, value: decode(entry.value) }),
      undefined,
      disposables,
    );
}

export type DynamicDevice = DeviceFacade<
  RuntimeModelClient['methods'],
  RuntimeModelClient['events']
>;
