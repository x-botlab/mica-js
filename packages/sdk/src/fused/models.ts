/**
 * Host side of one model instance (RFC 0021).
 *
 * The binding wraps the author factory: it builds the model context from the core device context
 * without the legacy topic bridge, validates the returned method interface, owns the declared event
 * outlets, turns business rejections into `MethodError` rejections and everything else into a model
 * fault, and keeps the client used by the host honest at runtime.
 */
import type { TimePs } from '@mica-js/core';
import { Emitter, toDisposable } from '@mica-js/core/lifecycle';
import type { Disposable, Event } from '@mica-js/core/lifecycle';
import type { Value, ValueType } from '@mica-js/document/fused';
import { validateModelValue } from '@mica-js/document/fused';
import type { DeviceAdapter, DeviceBatch, DeviceContext, JitOptions } from '@mica-js/simulator';
import type { ModelContext, ModelEvent, ModelEventEmitter } from './model.js';
import { isMethodError } from './model.js';
import { diagnostic } from './diagnostics.js';
import type { RuntimeDiagnostic } from './diagnostics.js';
import { byteViews, copyValue, isThenable, snapshotValue } from './values.js';

/** One declared event as the host observer sees it (installed before model initialization). */
export interface RuntimeModelEvent {
  readonly instanceId: string;
  /** Declared event name, e.g. `onDidBrightnessChange`. */
  readonly event: string;
  readonly payload: ModelEvent<Value>;
}

/** One method of a host-side client: parameters and result are checked at runtime. */
export type RuntimeMethod = (params: Value) => Promise<Value>;

/**
 * Dynamic client of one model instance.
 *
 * Only the names declared by the manifest resolve; the runtime validates parameter and result
 * values against the declared types, so no generic type parameter pretends to know more than the
 * running manifest does.
 */
export interface RuntimeModelClient {
  readonly methods: Readonly<Record<string, RuntimeMethod>>;
  readonly events: Readonly<Record<string, Event<ModelEvent<Value>> | undefined>>;
}

/** A model contract violation: its interface, payloads or execution are wrong. */
export class ModelFault extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelFault';
    this.code = code;
  }
}

/** Raised for a client whose model was replaced, faulted or disposed. */
export class ModelDisconnectedError extends Error {
  /** Contract diagnostic code (RFC 0021 `model/disconnected`). */
  readonly code = 'model/disconnected';

  constructor(message = 'The model client is disconnected from any live model') {
    super(message);
    this.name = 'ModelDisconnectedError';
  }
}

/** Model context as the fused runtime hands it to the author factory. */
export type FusedModelContext = ModelContext<
  DeviceContext,
  Record<string, unknown>,
  Readonly<Record<string, Value>>
>;

/** Author factory after the module boundary check. */
export type FusedModelFactory = (context: FusedModelContext) => unknown;

/** Live model instance as this host sees it; the shape is checked before it is stored. */
export interface CreatedModel {
  readonly methods: Record<string, (params: unknown) => unknown>;
  sync(batch: DeviceBatch): unknown;
  dispose(): unknown;
}

/** Declared interface of one model instance. */
export interface ModelInterface {
  readonly methods: Readonly<
    Record<string, { readonly params: ValueType; readonly returns: ValueType }>
  >;
  readonly events: Readonly<Record<string, ValueType>>;
  readonly types: Readonly<Record<string, ValueType>>;
}

export interface ModelBindingOptions extends ModelInterface {
  readonly instanceId: string;
  /** Resolved property snapshot handed to the factory. */
  readonly props: Readonly<Record<string, unknown>>;
  readonly factory: FusedModelFactory;
  readonly observer?: (event: RuntimeModelEvent) => void;
  readonly report: (entry: RuntimeDiagnostic) => void;
  /** Why model input is not allowed right now; `undefined` means it is. */
  readonly blocked: () => string | undefined;
  readonly now: () => TimePs;
}

/**
 * One declared event outlet.
 *
 * Dispatch uses the core {@link Emitter}; each receiver gets its own snapshot of the payload and a
 * failing receiver is reported and removed instead of disturbing the other listeners or the model.
 */
class Channel {
  readonly #emitter = new Emitter<ModelEvent<Value>>();
  readonly #report: (cause: unknown, what: string) => void;

  constructor(
    readonly name: string,
    report: (cause: unknown, what: string) => void,
  ) {
    this.#report = report;
  }

  readonly event: Event<ModelEvent<Value>> = (listener, thisArgs, disposables) => {
    const handle: { subscription?: Disposable } = {};
    let removed = false;
    const remove = (): void => {
      if (removed) {
        return;
      }
      removed = true;
      handle.subscription?.dispose();
    };
    handle.subscription = this.#emitter.event((payload) => {
      if (removed) {
        return undefined;
      }
      let result: unknown;
      try {
        result = listener.call(thisArgs, {
          value: copyValue(payload.value),
          simTime: payload.simTime,
          sequence: payload.sequence,
        });
      } catch (cause) {
        this.#report(cause, `listener of event "${this.name}"`);
        remove();
        return undefined;
      }
      if (isThenable(result)) {
        void Promise.resolve(result).catch((cause: unknown) => {
          this.#report(cause, `listener of event "${this.name}"`);
          remove();
        });
      }
      return result;
    });
    const disposable = toDisposable(remove);
    disposables?.push(disposable);
    return disposable;
  };

  fire(payload: ModelEvent<Value>): void {
    this.#emitter.fire(payload);
  }

  clear(): void {
    this.#emitter.dispose();
  }
}

export class ModelBinding {
  readonly #channels = new Map<string, Channel>();
  readonly #methods = new Map<string, (params: unknown) => unknown>();
  readonly #declaredMethods: readonly string[];
  readonly #options: ModelBindingOptions;
  #adapter: CreatedModel | undefined;
  #sequence = 0;
  #live = true;
  #client: RuntimeModelClient | undefined;

  constructor(options: ModelBindingOptions) {
    this.#options = options;
    this.#declaredMethods = Object.keys(options.methods);
    for (const name of Object.keys(options.events)) {
      this.#channels.set(
        name,
        new Channel(name, (cause, what) => {
          options.report(
            diagnostic(
              'runtime/presentation-failed',
              `${messageOf(cause)} (${what} on ${options.instanceId})`,
              options.instanceId,
            ),
          );
        }),
      );
    }
  }

  get instanceId(): string {
    return this.#options.instanceId;
  }

  get live(): boolean {
    return this.#live;
  }

  /** Parameter and result types of one declared method, or `undefined` for an unknown name. */
  methodDefinition(
    name: string,
  ): { readonly params: ValueType; readonly returns: ValueType } | undefined {
    return this.#options.methods[name];
  }

  /**
   * Creates the adapter the board registers for this instance.
   *
   * The factory runs here, so interface checks and initial events happen during the board's
   * initialization phase.
   */
  create(base: DeviceContext): DeviceAdapter {
    if (!this.#live) {
      throw new ModelDisconnectedError();
    }
    const context = this.#createContext(base);
    let instance: unknown;
    try {
      instance = this.#options.factory(context);
    } catch (cause) {
      throw this.#unwrap(
        cause,
        'model/execution-failed',
        `Model factory of ${this.instanceId} failed`,
      );
    }
    if (isThenable(instance)) {
      throw this.#fault(
        'model/async-handler',
        `Model factory of ${this.instanceId} returned a thenable`,
      );
    }
    const adapter = this.#validateInstance(instance);
    this.#adapter = adapter;
    return {
      sync: (batch: DeviceBatch) => {
        this.#sync(batch);
      },
      dispose: () => {
        this.#disposeAdapter();
      },
    };
  }

  /** Synchronous invocation used at a serialized safe boundary. */
  invoke(name: string, params: unknown): unknown {
    if (!this.#live || this.#adapter === undefined) {
      throw new ModelDisconnectedError();
    }
    const method = this.#methods.get(name);
    if (method === undefined) {
      throw new ModelFault(
        'model/unknown-method',
        `Model ${this.instanceId} has no method "${name}".`,
      );
    }
    const result = method(params);
    if (isThenable(result)) {
      throw new ModelFault(
        'model/async-handler',
        `Method "${name}" of ${this.instanceId} returned a thenable; model hooks must be synchronous.`,
      );
    }
    return result;
  }

  /**
   * Captures and validates one method parameter value before it is queued.
   *
   * Parameter failures reject the call without executing the handler and without faulting the
   * model, so they are reported to the caller only.
   */
  prepareParams(name: string, value: unknown): Value {
    const definition = this.methodDefinition(name);
    if (definition === undefined) {
      throw new ModelFault(
        'model/unknown-method',
        `Model ${this.instanceId} has no method "${name}".`,
      );
    }
    let snapshot: Value;
    try {
      snapshot = snapshotValue(value);
    } catch (cause) {
      throw new ModelFault(
        'model/invalid-params',
        `Parameters of "${name}" on ${this.instanceId} are not a model value: ${messageOf(cause)}`,
      );
    }
    try {
      validateModelValue(snapshot, definition.params, this.#options.types);
    } catch (cause) {
      throw new ModelFault(
        'model/invalid-params',
        `Parameters of "${name}" on ${this.instanceId} do not match the declared type: ${messageOf(cause)}`,
      );
    }
    return snapshot;
  }

  /** Captures an independent snapshot of one method result and validates it. */
  captureResult(name: string, value: unknown): Value {
    const definition = this.methodDefinition(name);
    if (definition === undefined) {
      throw new ModelFault(
        'model/unknown-method',
        `Model ${this.instanceId} has no method "${name}".`,
      );
    }
    return this.#capture(
      'model/invalid-result',
      `Method "${name}" of ${this.instanceId}`,
      value,
      definition.returns,
    );
  }

  /**
   * Host client of this instance.
   *
   * `invoke` is the runtime scheduler entry point: every declared method resolves to a function
   * that validates its parameters, waits for the next safe boundary and returns the result value.
   */
  client(invoke: (name: string, params: Value) => Promise<Value>): RuntimeModelClient {
    if (this.#client !== undefined) {
      return this.#client;
    }
    const methods: Record<string, RuntimeMethod> = {};
    for (const name of this.#declaredMethods) {
      methods[name] = (params: Value) => invoke(name, params);
    }
    const events: Record<string, Event<ModelEvent<Value>> | undefined> = {};
    for (const [name, channel] of this.#channels) {
      events[name] = channel.event;
    }
    const client: RuntimeModelClient = Object.freeze({
      methods: Object.freeze(methods),
      events: Object.freeze(events),
    });
    this.#client = client;
    return client;
  }

  /** Marks the binding dead after its model was replaced or released. */
  invalidate(): void {
    this.#live = false;
    this.#adapter = undefined;
    this.#methods.clear();
    for (const channel of this.#channels.values()) {
      channel.clear();
    }
    this.#client = undefined;
  }

  #createContext(base: DeviceContext): FusedModelContext {
    const props = this.#options.props;
    const outlets: Record<string, ModelEventEmitter<Value>> = {};
    for (const name of this.#channels.keys()) {
      outlets[name] = Object.freeze({
        fire: (value: Value) => {
          this.#emit(name, value, undefined);
        },
        fireTransferred: (value: Value, buffers: readonly ArrayBuffer[]) => {
          this.#emit(name, value, buffers);
        },
      });
    }
    const context: FusedModelContext = {
      get props() {
        return props;
      },
      get inputs() {
        return base.inputs;
      },
      get memory() {
        return base.memory;
      },
      reportError: (error: unknown) => base.reportError(error),
      attachJit: (options: JitOptions) => base.attachJit(options),
      loadBytes: (memory: string, bytes: Uint8Array, offset?: number) =>
        offset === undefined
          ? base.loadBytes(memory, bytes)
          : base.loadBytes(memory, bytes, offset),
      events: Object.freeze(outlets),
    };
    return Object.freeze(context);
  }

  #validateInstance(instance: unknown): CreatedModel {
    if (typeof instance !== 'object' || instance === null) {
      throw this.#fault(
        'model/invalid-interface',
        `Model ${this.instanceId} factory returned no instance`,
      );
    }
    const candidate = instance as {
      methods?: unknown;
      sync?: unknown;
      dispose?: unknown;
    };
    if (typeof candidate.sync !== 'function' || typeof candidate.dispose !== 'function') {
      throw this.#fault(
        'model/invalid-interface',
        `Model ${this.instanceId} must expose "sync" and "dispose" functions`,
      );
    }
    const table = candidate.methods;
    if (typeof table !== 'object' || table === null) {
      throw this.#fault(
        'model/invalid-interface',
        `Model ${this.instanceId} exposes no methods object`,
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(table);
    const names = Object.keys(descriptors);
    for (const name of names) {
      const descriptor = descriptors[name]!;
      if (
        !('value' in descriptor) ||
        typeof descriptor.value !== 'function' ||
        !descriptor.enumerable
      ) {
        throw this.#fault(
          'model/invalid-interface',
          `Method "${name}" of ${this.instanceId} must be an own enumerable function`,
        );
      }
    }
    const declared = new Set(this.#declaredMethods);
    for (const name of names) {
      if (!declared.has(name)) {
        throw this.#fault(
          'model/invalid-interface',
          `Model ${this.instanceId} implements the undeclared method "${name}"`,
        );
      }
    }
    for (const name of declared) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !('value' in descriptor)) {
        throw this.#fault(
          'model/invalid-interface',
          `Model ${this.instanceId} does not implement the declared method "${name}"`,
        );
      }
      const method = descriptor.value as (params: unknown) => unknown;
      this.#methods.set(name, (params: unknown) => method.call(table, params));
    }
    return candidate as unknown as CreatedModel;
  }

  #sync(batch: DeviceBatch): void {
    const adapter = this.#adapter;
    if (adapter === undefined || !this.#live) {
      return;
    }
    let result: unknown;
    try {
      result = adapter.sync(batch);
    } catch (cause) {
      throw this.#unwrap(cause, 'model/execution-failed', `sync of ${this.instanceId} failed`);
    }
    if (isThenable(result)) {
      throw this.#fault(
        'model/async-handler',
        `sync of ${this.instanceId} returned a thenable; model hooks must be synchronous.`,
      );
    }
  }

  #disposeAdapter(): void {
    const adapter = this.#adapter;
    this.#adapter = undefined;
    this.#live = false;
    let failure: unknown;
    try {
      const result = adapter?.dispose();
      if (isThenable(result)) {
        // Every model hook is synchronous, `dispose` included: a thenable is an implementation bug.
        void Promise.resolve(result).catch(() => {});
        failure = new ModelFault(
          'model/async-handler',
          `dispose of ${this.instanceId} returned a thenable; model hooks must be synchronous.`,
        );
      }
    } catch (cause) {
      failure = cause;
    }
    this.#methods.clear();
    for (const channel of this.#channels.values()) {
      channel.clear();
    }
    if (failure !== undefined) {
      this.#options.report(
        diagnostic(
          failure instanceof ModelFault ? failure.code : 'model/execution-failed',
          `${messageOf(failure)} (dispose of ${this.instanceId})`,
          this.instanceId,
        ),
      );
      throw failure;
    }
  }

  #emit(name: string, value: unknown, buffers: readonly ArrayBuffer[] | undefined): void {
    const blocked = this.#options.blocked();
    if (blocked !== undefined || !this.#live) {
      throw this.#fault(
        'model/invalid-phase',
        `Model ${this.instanceId} fired "${name}" outside an allowed phase: ${blocked ?? 'model is not live'}`,
      );
    }
    const channel = this.#channels.get(name);
    const type = this.#options.events[name];
    if (channel === undefined || type === undefined) {
      throw this.#fault(
        'model/unknown-event',
        `Model ${this.instanceId} fired the undeclared event "${name}"`,
      );
    }
    let source = value;
    if (buffers !== undefined) {
      try {
        assertTransfer(value, buffers);
        source = structuredClone(value, { transfer: [...buffers] });
      } catch (cause) {
        if (cause instanceof ModelFault) {
          this.#options.report(diagnostic(cause.code, cause.message, this.instanceId));
          throw cause;
        }
        throw this.#fault(
          'model/invalid-event',
          `Event "${name}" of ${this.instanceId} cannot transfer its buffers`,
          cause,
        );
      }
    }
    const captured = this.#capture(
      'model/invalid-event',
      `Event "${name}" of ${this.instanceId}`,
      source,
      type,
    );
    this.#sequence += 1;
    const payload: ModelEvent<Value> = Object.freeze({
      value: captured,
      simTime: this.#options.now(),
      sequence: this.#sequence,
    });
    channel.fire(payload);
    const observer = this.#options.observer;
    if (observer !== undefined) {
      try {
        observer({
          instanceId: this.instanceId,
          event: name,
          payload: {
            value: copyValue(captured),
            simTime: payload.simTime,
            sequence: payload.sequence,
          },
        });
      } catch (cause) {
        this.#options.report(
          diagnostic(
            'runtime/presentation-failed',
            `${messageOf(cause)} (onModelEvent observer of ${this.instanceId})`,
            this.instanceId,
          ),
        );
      }
    }
  }

  #capture(code: string, what: string, value: unknown, type: ValueType): Value {
    let snapshot: Value;
    try {
      snapshot = snapshotValue(value);
    } catch (cause) {
      throw this.#fault(code, `${what} produced an invalid value: ${messageOf(cause)}`);
    }
    try {
      validateModelValue(snapshot, type, this.#options.types);
    } catch (cause) {
      throw this.#fault(code, `${what} does not match the declared type: ${messageOf(cause)}`);
    }
    return snapshot;
  }

  /** Model faults and business rejections pass through; anything else becomes a fault. */
  #unwrap(cause: unknown, code: string, message: string): unknown {
    if (cause instanceof ModelFault || isMethodError(cause)) {
      return cause;
    }
    return this.#fault(code, message, cause);
  }

  #fault(code: string, message: string, cause?: unknown): ModelFault {
    const failure = new ModelFault(
      code,
      cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    );
    this.#options.report(diagnostic(code, failure.message, this.instanceId));
    return failure;
  }
}

function assertTransfer(value: unknown, buffers: readonly ArrayBuffer[]): void {
  if (!Array.isArray(buffers)) {
    throw new ModelFault('model/invalid-event', 'fireTransferred needs an array of buffers');
  }
  const seen = new Set<ArrayBuffer>();
  for (const buffer of buffers) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new ModelFault('model/invalid-event', 'fireTransferred buffers must be ArrayBuffers');
    }
    if (seen.has(buffer)) {
      throw new ModelFault('model/invalid-event', 'fireTransferred buffer is listed twice');
    }
    seen.add(buffer);
  }
  const views = byteViews(value);
  for (const buffer of buffers) {
    const covering = views.filter((entry) => entry.view.buffer === buffer);
    if (covering.length === 0) {
      throw new ModelFault(
        'model/invalid-event',
        'fireTransferred buffer is not part of the event payload',
      );
    }
    if (
      !covering.some(
        (entry) => entry.view.byteOffset === 0 && entry.view.byteLength === buffer.byteLength,
      )
    ) {
      throw new ModelFault(
        'model/invalid-event',
        'fireTransferred buffer must be covered completely by one Uint8Array of the payload',
      );
    }
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
