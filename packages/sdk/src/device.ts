import type { TimePs } from '@mica-js/core';
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type {
  DeviceAdapter,
  DeviceBatch,
  DeviceContext,
  ReadonlyBytes,
  TopicMessage,
} from '@mica-js/simulator';

export type {
  BorrowedBytes,
  ReadonlyBytes,
  ChannelMessage,
  Notification,
  DeviceAdapter,
  DeviceBatch,
  DeviceContext,
  DeviceFactory,
  InputChannel,
  InputNotification,
  TopicBridge,
  TopicMessage,
  JitHost,
  JitOptions,
  JitTranslate,
  JitTranslateInput,
  JitDelay,
  JitPolling,
  InstructionHook,
  Disposable,
  Event,
} from '@mica-js/simulator';

/**
 * Values that may cross the unified model method and event boundary.
 *
 * The domain is the MessagePack-compatible subset described by RFC 0021: null, booleans,
 * finite numbers, strings, byte arrays and nested arrays / plain string-keyed objects.
 */
export type Value =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly Value[]
  | { readonly [key: string]: Value };

/** A declarative value type used by `model.types`, method and event declarations. */
export type ValueType =
  | { readonly type: 'null' | 'boolean' | 'number' | 'string' | 'binary' }
  | { readonly type: 'array'; readonly items: ValueType }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, ValueType>>;
      readonly optional?: readonly string[];
      readonly additionalProperties?: ValueType;
    }
  | { readonly ref: string };

export interface MethodDefinition {
  readonly params: ValueType;
  readonly returns: ValueType;
}

export interface ModelDefinition {
  readonly entry: string;
  readonly types?: Readonly<Record<string, ValueType>>;
  readonly methods?: Readonly<Record<string, MethodDefinition>>;
  readonly events?: Readonly<Record<string, ValueType>>;
}

/** A business rejection: the host preserves `code`, `message` and `details` and rejects the call. */
export class MethodError extends Error {
  readonly code: string;
  readonly details?: Value;

  constructor(code: string, message: string, details?: Value) {
    super(message);
    this.name = 'MethodError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export type Methods = Readonly<Record<string, (params: never) => Value>>;
export type Params<F> = F extends (params: infer P) => Value ? P : never;
export type Result<F> = F extends (params: never) => infer R ? R : never;
export type AsyncMethods<M extends Methods> = {
  readonly [K in keyof M]: (params: Params<M[K]>) => Promise<Result<M[K]>>;
};

export interface ModelEventEmitter<T> {
  fire(value: T): void;
  fireTransferred(value: T, buffers: readonly ArrayBuffer[]): void;
}

export type ModelEvents<E extends Readonly<Record<string, Value>>> = {
  readonly [K in keyof E]: ModelEventEmitter<E[K]>;
};

/**
 * The model-side context of a unified device.
 *
 * The legacy bridge state (`props`, `topics`) is replaced by the resolved read-only property
 * snapshot and the declared event outlets. Every other capability of the core context remains
 * available, including inputs, memory, `loadBytes`, JIT attachment and error reporting.
 */
export type ModelContext<C, P extends object, E extends Readonly<Record<string, Value>>> = Omit<
  C,
  'props' | 'topics'
> & {
  readonly props: Readonly<P>;
  readonly events: ModelEvents<E>;
};

export interface ModelInstance<M extends Methods, B> extends Disposable {
  readonly methods: M;
  sync(batch: B): void;
}

export interface ModelModule<
  IR,
  C,
  P extends object,
  E extends Readonly<Record<string, Value>>,
  M extends Methods,
  B,
> {
  readonly model: IR;
  create(context: ModelContext<C, P, E>): ModelInstance<M, B>;
}

export interface ModelEvent<T> {
  readonly value: T;
  readonly simTime: TimePs;
  readonly sequence: number;
}

export type EventListeners<E> = {
  readonly [K in keyof E]: Event<ModelEvent<E[K]>>;
};

export interface ModelClient<M extends Methods, E extends Readonly<Record<string, Value>>> {
  readonly methods: AsyncMethods<M>;
  readonly events: EventListeners<E>;
}

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface Rect2D extends Point2D {
  readonly width: number;
  readonly height: number;
}

export interface PinGeometry2D {
  readonly position: Point2D;
  readonly outward: Point2D;
  readonly label?: { readonly position: Point2D; readonly visible?: boolean };
}

export interface Geometry2D {
  readonly sizing: 'physical' | 'flexible';
  readonly bounds: Rect2D;
  readonly bodyBounds: Rect2D;
  readonly bodyImage?: string;
  readonly pins: Readonly<Record<string, PinGeometry2D>>;
  readonly designator?: Point2D;
}

export interface View2DDefinition {
  readonly geometry: Geometry2D | string;
  readonly entry?: string;
}

export interface ViewAssets {
  read(path: string): Promise<Uint8Array>;
  loadImage(path: string): Promise<ImageBitmap>;
}

export interface ViewInput {
  readonly type: 'pointerdown' | 'pointerup' | 'pointermove';
  readonly position: Point2D;
  readonly button: number;
  readonly buttons: number;
}

export interface View2DContext<
  P = Record<string, unknown>,
  M extends Methods = Methods,
  E extends Readonly<Record<string, Value>> = Record<string, Value>,
> {
  readonly mode: 'edit' | 'run';
  readonly props: Readonly<P>;
  readonly geometry: Geometry2D;
  readonly model: ModelClient<M, E> | undefined;
  readonly assets: ViewAssets;
  invalidate(): void;
}

export interface View2D {
  initialize?(): void | Promise<void>;
  renderOverlay?(context: OffscreenCanvasRenderingContext2D): void;
  input?(event: ViewInput): void | Promise<void>;
  dispose?(): void;
}

export type View2DFactory<
  P = Record<string, unknown>,
  M extends Methods = Methods,
  E extends Readonly<Record<string, Value>> = Record<string, Value>,
> = (context: View2DContext<P, M, E>) => View2D;

export interface HtmlAssets {
  read(path: string): Promise<Uint8Array>;
  getUrl(path: string): Promise<string>;
}

export interface DeviceViewApi<
  P = Record<string, unknown>,
  M extends Methods = Methods,
  E extends Readonly<Record<string, Value>> = Record<string, Value>,
> {
  readonly props: Readonly<P>;
  readonly model: ModelClient<M, E> | undefined;
  readonly assets: HtmlAssets;
  readonly onDidClose: Event<void>;
}

export interface FirmwareSegment {
  readonly addressSpace: string;
  readonly address: number;
  readonly data: ReadonlyBytes;
}

export interface FirmwareImage {
  readonly segments: readonly FirmwareSegment[];
}

function readonlyByteView(bytes: Uint8Array): ReadonlyBytes {
  const copy = bytes.slice();
  const target = Object.freeze({
    get length() {
      return copy.length;
    },
    get byteLength() {
      return copy.length;
    },
    slice(start?: number, end?: number) {
      return copy.slice(start, end);
    },
    *[Symbol.iterator]() {
      yield* copy;
    },
  });
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return copy[Number(key)];
      return Reflect.get(object, key, receiver);
    },
    set() {
      throw new TypeError('Bytes are read-only');
    },
    defineProperty() {
      throw new TypeError('Bytes are read-only');
    },
  }) as unknown as ReadonlyBytes;
}

/** Captures an independent read-only byte snapshot for factory properties. */
export function readonlyBytes(bytes: Uint8Array): ReadonlyBytes {
  return readonlyByteView(bytes);
}

/**
 * Captures, validates and sorts an immutable firmware image for a factory property.
 *
 * Segments must be nonempty, nonempty in data, ordered by address space and address after
 * capture, and non-overlapping within one address space. Address ranges are checked against
 * safe-integer arithmetic only; whether a segment fits the manifest address space is the
 * caller's responsibility.
 */
export function firmwareImage(
  segments: readonly {
    readonly addressSpace: string;
    readonly address: number;
    readonly data: Uint8Array;
  }[],
): FirmwareImage {
  if (!Array.isArray(segments) || segments.length === 0)
    throw new TypeError('Firmware image must contain at least one segment');
  const captured = segments.map((segment) => {
    if (typeof segment.addressSpace !== 'string' || segment.addressSpace.length === 0)
      throw new TypeError('Firmware segment addressSpace must be a nonempty string');
    if (!Number.isSafeInteger(segment.address) || segment.address < 0)
      throw new RangeError('Firmware segment address must be a nonnegative safe integer');
    if (!(segment.data instanceof Uint8Array))
      throw new TypeError('Firmware segment data must be a Uint8Array');
    if (segment.data.length === 0) throw new RangeError('Firmware segment data must not be empty');
    if (!Number.isSafeInteger(segment.address + segment.data.length))
      throw new RangeError('Firmware segment range must be a safe integer');
    return Object.freeze({
      addressSpace: segment.addressSpace,
      address: segment.address,
      data: readonlyByteView(segment.data),
    });
  });
  captured.sort((left, right) => {
    if (left.addressSpace < right.addressSpace) return -1;
    if (left.addressSpace > right.addressSpace) return 1;
    return left.address - right.address;
  });
  let previous: { readonly addressSpace: string; readonly end: number } | undefined;
  for (const segment of captured) {
    const end = segment.address + segment.data.length;
    if (previous !== undefined && previous.addressSpace === segment.addressSpace) {
      if (segment.address < previous.end)
        throw new RangeError(
          `Firmware segments overlap in address space "${segment.addressSpace}"`,
        );
    }
    previous = { addressSpace: segment.addressSpace, end };
  }
  return Object.freeze({ segments: Object.freeze(captured) });
}

function byteSnapshot(value: object): value is { slice(): Uint8Array } {
  const candidate = value as {
    readonly slice?: unknown;
    readonly byteLength?: unknown;
    readonly length?: unknown;
  };
  return (
    typeof candidate.slice === 'function' &&
    typeof candidate.byteLength === 'number' &&
    typeof candidate.length === 'number'
  );
}

/** Copies and deeply freezes factory properties; each adapter instance receives its own aliases. */
function snapshotProps(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind === 'boolean' || kind === 'number' || kind === 'string') return value;
  if (value instanceof Uint8Array) return readonlyByteView(value);
  if (kind !== 'object') throw new TypeError('Adapter props must contain only data values');
  const object = value as object;
  if (seen.has(object)) throw new TypeError('Adapter props must be acyclic');
  seen.add(object);
  try {
    if (byteSnapshot(object)) return readonlyByteView(object.slice());
    if (Array.isArray(object))
      return Object.freeze(object.map((item) => snapshotProps(item, seen)));
    if (
      Object.getPrototypeOf(object) !== Object.prototype &&
      Object.getPrototypeOf(object) !== null
    )
      throw new TypeError(
        'Adapter props must contain only plain objects, arrays and byte snapshots',
      );
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object))
      Object.defineProperty(copy, key, {
        value: snapshotProps(item, seen),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    return Object.freeze(copy);
  } finally {
    seen.delete(object);
  }
}

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
  /**
   * Explicit model event to legacy topic mapping. There is no name-based inference: firing an
   * event that is not listed here is discarded instead of failing the model.
   */
  readonly events?: Readonly<Record<string, string | AdaptModelEventOptions>>;
  /**
   * Explicit legacy topic to model method mapping. There is no name-based inference: a topic that
   * is not listed here is not delivered to the model.
   */
  readonly inputs?: Readonly<Record<string, string | AdaptModelInputOptions>>;
}

export type AdaptedModelInstance<
  M extends Methods,
  B extends DeviceBatch = DeviceBatch,
> = DeviceAdapter<B> & {
  readonly methods: M;
};

function eventConfig(value: string | AdaptModelEventOptions): AdaptModelEventOptions {
  return typeof value === 'string' ? { topic: value } : value;
}

function inputConfig(value: string | AdaptModelInputOptions): AdaptModelInputOptions {
  return typeof value === 'string' ? { method: value } : value;
}

/**
 * Connects a unified model factory to the existing simulator `DeviceFactory` boundary.
 *
 * The bridge deliberately does not emulate the fused runtime: it forwards `sync` batches,
 * publishes configured model events as legacy topics and invokes configured model methods for
 * legacy topics. `fireTransferred` publishes the payload without taking ownership of the
 * buffers, and `simTime` defaults to zero because the legacy context has no simulation clock.
 * Full resolved properties must be supplied explicitly when the board cannot represent them.
 */
export function adaptModelFactory<
  C extends DeviceContext,
  P extends object,
  E extends Readonly<Record<string, Value>>,
  M extends Methods,
  B extends DeviceBatch,
>(
  factory: (context: ModelContext<C, P, E>) => ModelInstance<M, B>,
  options: AdaptModelOptions<P> = {},
): (context: DeviceContext) => AdaptedModelInstance<M, B> {
  return (context) => {
    const { topics, props: legacyProps, ...capabilities } = context as DeviceContext;
    void legacyProps;
    const resolved =
      typeof options.props === 'function'
        ? options.props(context as DeviceContext)
        : (options.props ?? (context.props as Readonly<P>));
    const isolated = snapshotProps(resolved) as Readonly<P>;
    const events: Record<string, ModelEventEmitter<unknown>> = {};
    for (const [name, raw] of Object.entries(options.events ?? {})) {
      const config = eventConfig(raw);
      events[name] = Object.freeze({
        fire(value: unknown) {
          const payload = config.transform ? config.transform(value) : value;
          topics.publish(config.topic, payload);
        },
        fireTransferred(value: unknown, buffers: readonly ArrayBuffer[]) {
          void buffers;
          const payload = config.transform ? config.transform(value) : value;
          topics.publish(config.topic, payload);
        },
      });
    }
    Object.freeze(events);
    const discarded = Object.freeze({
      fire() {},
      fireTransferred() {},
    }) as ModelEventEmitter<unknown>;
    const eventSink = new Proxy(events, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !Object.hasOwn(target, key)) return discarded;
        return Reflect.get(target, key, receiver);
      },
    });
    const modelContext = {
      ...capabilities,
      props: isolated,
      events: eventSink,
    } as unknown as ModelContext<C, P, E>;
    const instance = factory(modelContext);
    const subscriptions: Disposable[] = [];
    if (options.inputs !== undefined && Object.keys(options.inputs).length > 0) {
      const mappings = new Map(
        Object.entries(options.inputs).map(([topic, raw]) => [topic, inputConfig(raw)] as const),
      );
      subscriptions.push(
        context.topics.onDidReceive(({ topic, payload }: TopicMessage) => {
          const mapping = mappings.get(topic);
          if (mapping === undefined) return;
          const method = (
            instance.methods as unknown as Record<
              string,
              ((params: unknown) => unknown) | undefined
            >
          )[mapping.method];
          if (typeof method !== 'function') {
            context.reportError(
              new Error(`Legacy topic "${topic}" maps to unknown model method "${mapping.method}"`),
            );
            return;
          }
          try {
            const result = method(mapping.params ? mapping.params(payload) : payload);
            if (result !== null && typeof (result as { then?: unknown }).then === 'function') {
              context.reportError(
                new Error(`Model method "${mapping.method}" returned a thenable`),
              );
            }
          } catch (error) {
            context.reportError(error);
          }
        }),
      );
    }
    let disposed = false;
    return {
      methods: instance.methods,
      sync(batch: B) {
        instance.sync(batch);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        let failure: unknown;
        for (const subscription of subscriptions.splice(0).reverse()) {
          try {
            subscription.dispose();
          } catch (error) {
            failure ??= error;
          }
        }
        try {
          instance.dispose();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      },
    };
  };
}
