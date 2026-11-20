import type {
  DeviceAdapter,
  DeviceBatch,
  DeviceContext,
  FirmwareImage,
  Methods,
  ModelContext,
  ModelEventEmitter,
  ModelInstance,
  Value,
} from '@mica-js/sdk/device';

export interface AdaptModelEventOptions {
  /** Legacy topic that receives this model event. */
  readonly topic: string;
  /** Maps the model payload to the legacy topic payload; defaults to the payload itself. */
  readonly transform?: (value: unknown) => unknown;
}

export interface AdaptModelInputOptions {
  /** Unified model method invoked for this legacy topic. */
  readonly method: string;
  /** Maps the legacy topic payload to the method parameter; defaults to the payload itself. */
  readonly params?: (payload: unknown) => unknown;
}

export interface AdaptModelOptions<P extends object> {
  /**
   * Complete resolved properties, including firmware and resource snapshots that
   * `BoardDescription.props` cannot carry. Values are deeply copied and frozen per instance;
   * when omitted, the legacy context properties are snapshotted instead.
   */
  readonly props?: Readonly<P> | ((context: DeviceContext) => Readonly<P>);
  /** Explicit model event to legacy topic mapping; unmapped events are discarded. */
  readonly events?: Readonly<Record<string, string | AdaptModelEventOptions>>;
  /** Explicit legacy topic to model method mapping; unmapped topics are not delivered. */
  readonly inputs?: Readonly<Record<string, string | AdaptModelInputOptions>>;
}

export type AdaptedModelInstance<
  M extends Methods,
  B extends DeviceBatch = DeviceBatch,
> = DeviceAdapter<B> & {
  readonly methods: M;
};

/** Captures, validates and sorts an immutable firmware image for a factory property. */
export function firmwareImage(
  segments: readonly {
    readonly addressSpace: string;
    readonly address: number;
    readonly data: Uint8Array;
  }[],
): FirmwareImage;

/** Connects a unified model factory to the legacy simulator `DeviceFactory` boundary. */
export function adaptModelFactory<
  C extends DeviceContext,
  P extends object,
  E extends Readonly<Record<string, Value>>,
  M extends Methods,
  B extends DeviceBatch,
>(
  factory: (context: ModelContext<C, P, E>) => ModelInstance<M, B>,
  options?: AdaptModelOptions<P>,
): (context: DeviceContext) => AdaptedModelInstance<M, B>;

export type {
  DeviceAdapter,
  DeviceBatch,
  DeviceContext,
  FirmwareImage,
  Methods,
  ModelContext,
  ModelEventEmitter,
  ModelInstance,
  Value,
};
