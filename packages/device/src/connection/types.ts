import type { TopologyRuntime } from '@mica-js/core';
import type { ScalarType, StaticRef, Value } from '@mica-js/ir';

/** One internal controlled connection declared by a device description (#14). */
export interface DeviceConnectionDescriptor {
  readonly key: string;
  /** Exactly two distinct pin ids declared by the same description. */
  readonly pins: readonly [string, string];
  readonly initial: 'open' | 'closed';
}

/** Static handle for one declared connection; never a runtime state object. */
export type ConnectionRef = StaticRef<'connection'>;

/** `b.connection` operations (#8 / #14). */
export interface ConnectionOperations {
  /**
   * Emit one `connection.apply` instruction. The whole list is captured as one atomic patch at
   * the topology's next legal commit point; the call returns nothing.
   */
  apply(
    patch: readonly {
      readonly connection: ConnectionRef;
      readonly closed: Value<'bool'>;
    }[],
  ): undefined;
}

/** Host binding for device-owned connections (#57). */
export interface DeviceConnectionOptions {
  /** Topology that owns this instance's declared connection states. */
  readonly topology: TopologyRuntime;
}

declare module '@mica-js/ir' {
  // The type parameter must match the core declaration for interface merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface FunctionBuilder<R extends readonly ScalarType[] = readonly []> {
    readonly connection: ConnectionOperations;
  }
}
