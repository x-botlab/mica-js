import type { TopicBridge } from '../types';

/**
 * Facts the adapter layer needs about a bridge, kept off the public `TopicBridge` contract.
 *
 * A bridge's `publish` both delivers and enforces the board's call admission (alive, phase,
 * faulted). A caller that decides nobody would receive a message still has to run that
 * admission, and it has to know whether any owner-less listener exists. Both are internal to
 * this package: device adapters and hosts act through `onDidReceive` and `publish` only.
 */
export interface PublishGate {
  /** The same admission `publish` runs first, without copying, freezing or dispatching. */
  assertPublishAllowed(): void;
  /** Owner-less listeners of the shared dispatch set: the host's direct subscriptions. */
  hostListeners(): number;
}

const gates = new WeakMap<object, PublishGate>();

/** Attach the gate to the facade the board hands out; never exposed through the package entry. */
export function registerPublishGate(bridge: object, gate: PublishGate): void {
  gates.set(bridge, gate);
}

export function publishGate(bridge: TopicBridge): PublishGate {
  const gate = gates.get(bridge);
  if (gate === undefined) throw new TypeError('Topic bridge was not created by a board');
  return gate;
}
