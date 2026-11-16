/**
 * Author-facing surface of a unified device model (RFC 0021).
 *
 * A model entry is a self-contained module that exports the device `model` IR and a synchronous
 * `create` factory. The factory receives a {@link ModelContext}: the core device context without
 * the legacy topic bridge, plus the resolved property snapshot and the declared event outlets.
 */
import type { TimePs } from '@mica-js/core';
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { DeviceIR } from '@mica-js/device-model';
import type { Value, ValueType } from '@mica-js/document/fused';

/** Declared method map of one model instance. */
export type Methods = Readonly<Record<string, (params: never) => Value>>;
/** Declared parameter value of one method. */
export type Params<F> = F extends (params: infer P) => Value ? P : never;
/** Declared result value of one method. */
export type Result<F> = F extends (params: never) => infer R ? R : never;
/** Host-side projection of {@link Methods}: every call is asynchronous. */
export type AsyncMethods<M extends Methods> = {
  readonly [K in keyof M]: (params: Params<M[K]>) => Promise<Result<M[K]>>;
};

/** Outlet the model fires one declared event payload through. */
export interface ModelEventEmitter<T> {
  /** Delivers an independent snapshot of `value` to the listeners active at that moment. */
  fire(value: T): void;
  /**
   * Delivers `value` after the payload takes ownership of `buffers`.
   *
   * Each buffer must be covered exactly by one `Uint8Array` member of the payload; a successful
   * call hands ownership over through the host transfer hooks.
   */
  fireTransferred(value: T, buffers: readonly ArrayBuffer[]): void;
}

/** Event outlets of a model, keyed by the `model.events` declaration. */
export type ModelEvents<E extends Readonly<Record<string, Value>>> = {
  readonly [K in keyof E]: ModelEventEmitter<E[K]>;
};

/**
 * Model context: the core device context without `props` and the legacy `topics` bridge.
 *
 * `props` is the resolved, independent and read-only property snapshot; `events` are the declared
 * outlets and only expose firing, never subscription.
 */
export type ModelContext<
  C extends object,
  P extends object,
  E extends Readonly<Record<string, Value>>,
> = Omit<C, 'props' | 'topics'> & {
  readonly props: Readonly<P>;
  readonly events: ModelEvents<E>;
};

/** Live model instance returned by the entry factory. */
export interface ModelInstance<M extends Methods, B> extends Disposable {
  readonly methods: M;
  /** Consumes the compiled adapter output of one virtual step. */
  sync(batch: B): void;
}

/** Shape of a model entry module: the device IR plus its synchronous factory. */
export interface ModelModule<
  IR = DeviceIR,
  C extends object = object,
  P extends object = object,
  E extends Readonly<Record<string, Value>> = Readonly<Record<string, Value>>,
  M extends Methods = Methods,
  B = unknown,
> {
  readonly model: IR;
  create(context: ModelContext<C, P, E>): ModelInstance<M, B>;
}

/** One delivered model event: payload, production time and per-instance sequence. */
export interface ModelEvent<T> {
  readonly value: T;
  readonly simTime: TimePs;
  /** Strictly increasing safe integer per model instance lifetime; a new model restarts at 1. */
  readonly sequence: number;
}

/** Declared event subscriptions of one model instance. */
export type EventListeners<E extends Readonly<Record<string, Value>>> = {
  readonly [K in keyof E]: Event<ModelEvent<E[K]>>;
};

/** Host-side client of one model instance. */
export interface ModelClient<M extends Methods, E extends Readonly<Record<string, Value>>> {
  readonly methods: AsyncMethods<M>;
  readonly events: EventListeners<E>;
}

/**
 * Realm-wide marker of {@link MethodError}.
 *
 * A built device artifact bundles its own copy of this SDK, so `instanceof` alone cannot recognize
 * the class it constructs. The registered symbol is shared by every copy in one realm, which is
 * what the runtime checks first.
 */
export const METHOD_ERROR_TAG = Symbol.for('mica-js.sdk/method-error');

/**
 * Business rejection of one model method (RFC 0021).
 *
 * The host keeps `code`, `message` and the optional `details` value intact and rejects the call
 * without treating the model as faulted.
 */
export class MethodError extends Error {
  readonly code: string;
  readonly details?: Value;

  constructor(code: string, message: string, details?: Value) {
    super(message);
    this.name = 'MethodError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    Object.defineProperty(this, METHOD_ERROR_TAG, { value: true });
  }
}

/**
 * Whether a thrown value is a `MethodError`, including one constructed by a bundled copy of this
 * SDK: the marker symbol or the class name plus a string `code` is enough.
 */
export function isMethodError(value: unknown): value is MethodError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (value instanceof MethodError) {
    return true;
  }
  const candidate = value as { readonly name?: unknown; readonly code?: unknown };
  if (typeof candidate.code !== 'string') {
    return false;
  }
  if ((value as Record<symbol, unknown>)[METHOD_ERROR_TAG] === true) {
    return true;
  }
  return candidate.name === 'MethodError' && typeof (value as Error).message === 'string';
}

/** Signature a model factory has for one manifest interface; handy for typed implementations. */
export type ModelFactory<
  C extends object = object,
  P extends object = object,
  E extends Readonly<Record<string, Value>> = Readonly<Record<string, Value>>,
  M extends Methods = Methods,
  B = unknown,
> = (context: ModelContext<C, P, E>) => ModelInstance<M, B>;

export type { Value, ValueType };
