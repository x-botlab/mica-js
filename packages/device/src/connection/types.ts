import type { TopologyRuntime } from '@mica-js/core';
import type { IRDeclarations, ScalarType, StaticRef, Value } from '@mica-js/ir';

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

/**
 * Device-scoped IR declarations. Extending `IRDeclarations` here (instead of augmenting it)
 * keeps the core module free of connection knowledge while exposing the confirmed author API.
 */
export interface DeviceIRDeclarations extends IRDeclarations {
  /** Resolve a connection declared by this device description; never exposes state. */
  connection(id: string): ConnectionRef;
}

declare module '@mica-js/ir' {
  // The type parameter must match the core declaration for interface merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface FunctionBuilder<R extends readonly ScalarType[] = readonly []> {
    readonly connection: ConnectionOperations;
  }
}
