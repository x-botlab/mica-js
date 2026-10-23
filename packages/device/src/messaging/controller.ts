import type {
  BytesOutputRef,
  BytesRef,
  EntryRef,
  FunctionDefinition,
  InboxRef,
  IRBridgeHost,
  IRModule,
  IRStorage,
  MemoryDefinition,
  OutputDefinition,
  OutputRef,
  RuntimeScalar,
  ScalarType,
} from '@mica-js/ir';
import type { SchedulerExecutionContext } from '@mica-js/core';
import { DeviceError } from '../errors';
import { callableKind, consumeThenable, isThenable } from '../internal/functions';
import { isPlainRecord } from '../internal/records';
import type {
  DeviceDescription,
  DeviceMessagingOptions,
  DeviceTopicMessage,
  IROutputMetadata,
  TopicMetadata,
  TopicPayload,
  Unsubscribe,
} from '../types';
import { BackpressureError } from './errors';
import type { BackpressureOperation } from './errors';
import { messagingError } from './errors';
import { InboxAllocator } from './inbox';
import { captureTopicMetadata, captureTopicPayload, cloneTopicPayload } from './payload';

const DEFAULT_LIMITS = Object.freeze({
  postCapacity: 64,
  publishCapacity: 64,
  deliveryCapacity: 64,
  updateCapacity: 64,
  outputByteBudget: 65536,
});

export interface ResolvedMessagingLimits {
  readonly postCapacity: number;
  readonly publishCapacity: number;
  readonly deliveryCapacity: number;
  readonly updateCapacity: number;
  readonly outputByteBudget: number;
}

export interface MessagingRuntime {
  readonly storage: IRStorage;
  enqueueMessage(target: EntryRef, args: readonly RuntimeScalar[]): number;
  isFaulted(): boolean;
}

export interface MessagingControllerOptions {
  readonly module: IRModule;
  readonly description: DeviceDescription;
  readonly deviceId: string;
  readonly options?: DeviceMessagingOptions;
  readonly onTopic?: (message: DeviceTopicMessage) => void;
}

type TopicListener = {
  readonly callback: (payload: TopicPayload, meta: TopicMetadata) => void | Promise<void>;
};

type OutputCallback = (payload: unknown, meta: IROutputMetadata) => void | Promise<void>;

type Outstanding =
  | { readonly kind: 'post' }
  | {
      readonly kind: 'postBytes';
      readonly inbox: InboxRef;
      readonly offset: number;
      readonly length: number;
    };

type OutputMessage =
  | {
      readonly kind: 'scalar';
      readonly ref: object;
      readonly payload: readonly (boolean | number)[];
      readonly timePs: number;
    }
  | {
      readonly kind: 'bytes';
      readonly ref: object;
      readonly bytes: Uint8Array;
      readonly timePs: number;
    };

interface InputMessage {
  readonly port: string;
  readonly payload: TopicPayload;
  readonly meta: TopicMetadata;
}

interface PublishMessage {
  readonly port: string;
  readonly payload: TopicPayload;
}

interface UpdateRequest {
  readonly ref: BytesRef;
  readonly offset: number;
  readonly bytes: Uint8Array;
  resolve(): void;
  reject(reason: unknown): void;
}

export class MessagingController {
  readonly #module: IRModule;
  readonly #description: DeviceDescription;
  readonly #deviceId: string;
  readonly #limits: ResolvedMessagingLimits;
  readonly #onTopic: ((message: DeviceTopicMessage) => void) | undefined;
  #inbox = new InboxAllocator([]);
  readonly #outputMap = new Map<object, OutputDefinition>();
  readonly #functionMap = new Map<object, FunctionDefinition>();
  readonly #memoryMap = new Map<object, MemoryDefinition>();
  #updateResources: ReadonlySet<object> = new Set();
  readonly #subscriptions = new Map<string, TopicListener[]>();
  readonly #outputListeners = new Map<object, OutputCallback>();
  readonly #outputQueue: OutputMessage[] = [];
  readonly #outputCounts = new Map<object, number>();
  readonly #pendingInputs: InputMessage[] = [];
  readonly #pendingPublish: PublishMessage[] = [];
  readonly #pendingUpdates: UpdateRequest[] = [];
  readonly #outstanding = new Map<number, Outstanding>();
  #outputBytes = 0;
  #runtime: MessagingRuntime | undefined;
  #registrationsOpen = true;
  #closed = false;
  #destroyed = false;
  #ready = false;
  #executing = false;
  #draining = false;
  #localFault = false;

  constructor(options: MessagingControllerOptions) {
    this.#module = options.module;
    this.#description = options.description;
    this.#deviceId = options.deviceId;
    this.#limits = resolveMessagingOptions(options.options, options.deviceId);
    if (options.onTopic !== undefined) {
      if (callableKind(options.onTopic) !== 'function') {
        throw messagingError(
          'device/message-callback',
          options.deviceId,
          'onTopic must be a synchronous non-generator function.',
        );
      }
      this.#onTopic = options.onTopic;
    } else {
      this.#onTopic = undefined;
    }
  }

  /** Captures declarations made by the synchronous factory; call once after it returns. */
  bindDeclarations(): void {
    this.#outputMap.clear();
    this.#functionMap.clear();
    this.#memoryMap.clear();
    for (const output of this.#module.outputs) {
      this.#outputMap.set(output.ref, output);
    }
    for (const fn of this.#module.functions) {
      this.#functionMap.set(fn.ref, fn);
    }
    for (const memory of this.#module.memories) {
      this.#memoryMap.set(memory.ref, memory);
    }
    this.#inbox = new InboxAllocator(this.#module.memories);
  }

  /** Applies the host's independent update grant resolved from DeviceInstanceOptions. */
  setUpdateResources(resources: ReadonlySet<object>): void {
    this.#updateResources = resources;
  }

  readonly bridge: IRBridgeHost = Object.freeze({
    send: (output: OutputRef, payload: readonly (boolean | number)[], timePs: number): boolean =>
      this.#sendScalar(output, payload, timePs),
    sendBytes: (output: BytesOutputRef, bytes: Uint8Array, timePs: number): boolean =>
      this.#sendBytes(output, bytes, timePs),
  });

  isFaulted(): boolean {
    return this.#localFault;
  }

  /** Stops new listener registrations when the synchronous factory returns. */
  closeRegistrations(): void {
    this.#registrationsOpen = false;
  }

  /** Drops all pending state after a factory/binding/link failure. */
  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    this.#registrationsOpen = false;
    this.#subscriptions.clear();
    this.#outputListeners.clear();
    this.#outputQueue.length = 0;
    this.#outputCounts.clear();
    this.#outputBytes = 0;
    this.#pendingInputs.length = 0;
    this.#pendingPublish.length = 0;
    this.#rejectUpdates('device/not-active');
    this.#outstanding.clear();
    this.#inbox = new InboxAllocator([]);
    this.#outputMap.clear();
    this.#functionMap.clear();
    this.#memoryMap.clear();
    this.#updateResources = new Set();
    this.#runtime = undefined;
  }

  attach(runtime: MessagingRuntime): void {
    this.#assertOpen('attach');
    this.#runtime = runtime;
  }

  /** Called after initialize returns successfully, before the entry boundary drains. */
  markReady(): void {
    if (this.#closed || this.#destroyed) return;
    this.#ready = true;
  }

  beforeEntry(): void {
    if (this.#closed || this.#destroyed) return;
    this.#executing = true;
  }

  completeEntry(context: SchedulerExecutionContext, failure: unknown): void {
    if (failure !== undefined) {
      this.#localFault = true;
    }
    this.#releaseOutstanding(context.messageId);
    this.#executing = false;
    this.#draining = true;
    let firstError: unknown = failure;
    try {
      if (this.#ready) {
        do {
          try {
            this.#flushUpdates();
          } catch (cause) {
            firstError ??= cause;
          }
          try {
            this.#drainOutputs();
          } catch (cause) {
            firstError ??= cause;
          }
          if (failure === undefined && firstError === undefined) {
            try {
              this.#drainInputs();
            } catch (cause) {
              firstError ??= cause;
            }
          }
          try {
            this.#drainPublish();
          } catch (cause) {
            firstError ??= cause;
          }
          // Callbacks may have queued new updates or cross-queue work during this pass.
          try {
            this.#flushUpdates();
          } catch (cause) {
            firstError ??= cause;
          }
        } while (
          this.#pendingUpdates.length > 0 ||
          this.#outputQueue.length > 0 ||
          (failure === undefined && firstError === undefined && this.#pendingInputs.length > 0) ||
          this.#pendingPublish.length > 0
        );
      }
    } finally {
      this.#draining = false;
      this.#executing = false;
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#ready = false;
    this.#registrationsOpen = false;
    // Accepted publish messages are external effects; make a best effort to hand them to
    // the host sink before dropping instance-local state.
    try {
      this.#drainPublish();
    } catch {
      // Cleanup must continue; the host sink cannot prevent kernel resource release.
    }
    this.#subscriptions.clear();
    this.#outputListeners.clear();
    this.#outputQueue.length = 0;
    this.#outputCounts.clear();
    this.#outputBytes = 0;
    this.#pendingInputs.length = 0;
    this.#pendingPublish.length = 0;
    this.#rejectUpdates('device/instance-destroyed');
    this.#outstanding.clear();
    this.#inbox = new InboxAllocator([]);
    this.#outputMap.clear();
    this.#functionMap.clear();
    this.#memoryMap.clear();
    this.#runtime = undefined;
  }

  subscribe(port: string, callback: unknown): Unsubscribe {
    this.#assertRegistration('subscribe');
    const descriptor = this.#description.ports.get(port);
    if (descriptor === undefined) {
      throw messagingError(
        'device/topic-unknown',
        this.#deviceId,
        `subscribe received unknown port ${JSON.stringify(port)}.`,
      );
    }
    if (descriptor.direction !== 'input') {
      throw messagingError(
        'device/topic-direction',
        this.#deviceId,
        `subscribe requires an input port, but ${JSON.stringify(port)} is an output.`,
      );
    }
    assertMessageCallback(callback, this.#deviceId, 'subscribe');
    const list = this.#subscriptions.get(port) ?? [];
    if (list.some((entry) => entry.callback === callback)) {
      throw messagingError(
        'device/topic-subscription',
        this.#deviceId,
        `subscribe received the same callback twice for port ${JSON.stringify(port)}.`,
      );
    }
    const entry: TopicListener = {
      callback: callback as TopicListener['callback'],
    };
    list.push(entry);
    this.#subscriptions.set(port, list);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.#subscriptions.get(port);
      if (current === undefined) return;
      const index = current.indexOf(entry);
      if (index < 0) return;
      current.splice(index, 1);
      if (current.length === 0) this.#subscriptions.delete(port);
    };
  }

  publish(port: string, payload: TopicPayload): void {
    this.#assertOpen('publish');
    const descriptor = this.#description.ports.get(port);
    if (descriptor === undefined) {
      throw messagingError(
        'device/topic-unknown',
        this.#deviceId,
        `publish received unknown port ${JSON.stringify(port)}.`,
      );
    }
    if (descriptor.direction !== 'output') {
      throw messagingError(
        'device/topic-direction',
        this.#deviceId,
        `publish requires an output port, but ${JSON.stringify(port)} is an input.`,
      );
    }
    const captured = captureTopicPayload(this.#deviceId, port, descriptor.type, payload);
    this.#assertReady('publish');
    if (this.#onTopic === undefined) {
      return;
    }
    if (this.#pendingPublish.length >= this.#limits.publishCapacity) {
      throw this.#backpressure(
        'publish',
        `publish queue for port ${JSON.stringify(port)} is full (${this.#limits.publishCapacity} messages).`,
      );
    }
    this.#pendingPublish.push({ port, payload: captured });
    if (!this.#executing && !this.#draining) {
      this.#drainPublish();
    }
  }

  post<P extends readonly ScalarType[]>(
    entry: EntryRef<P>,
    args: readonly (boolean | number)[],
  ): Promise<void> {
    try {
      this.#assertOpen('post');
      const definition = this.#entryDefinition(entry, 'post');
      const captured = this.#captureArgs(definition, args);
      const runtime = this.#requireRuntime('post');
      if (this.#outstanding.size >= this.#limits.postCapacity) {
        throw this.#backpressure(
          'post',
          `post queue has reached its ${this.#limits.postCapacity}-message limit.`,
        );
      }
      const messageId = runtime.enqueueMessage(entry, captured);
      this.#outstanding.set(messageId, { kind: 'post' });
    } catch (cause) {
      return Promise.reject(this.#operationError('post', cause));
    }
    return Promise.resolve();
  }

  postBytes(
    entry: EntryRef<readonly ['u32', 'u32']>,
    inbox: InboxRef,
    bytes: Uint8Array,
  ): Promise<void> {
    try {
      this.#assertOpen('postBytes');
      const definition = this.#entryDefinition(entry, 'postBytes');
      if (
        definition.params.length !== 2 ||
        definition.params[0] !== 'u32' ||
        definition.params[1] !== 'u32'
      ) {
        throw messagingError(
          'device/message-target',
          this.#deviceId,
          `postBytes entry ${JSON.stringify(definition.name)} must take [u32, u32].`,
        );
      }
      const memory = this.#inboxMemory(inbox);
      if (!(bytes instanceof Uint8Array)) {
        throw messagingError(
          'device/message-target',
          this.#deviceId,
          'postBytes bytes must be a Uint8Array.',
        );
      }
      const captured = new Uint8Array(bytes);
      const runtime = this.#requireRuntime('postBytes');
      if (this.#outstanding.size >= this.#limits.postCapacity) {
        throw this.#backpressure(
          'postBytes',
          `post queue has reached its ${this.#limits.postCapacity}-message limit.`,
        );
      }
      const offset = this.#inbox.reserve(inbox, captured.length);
      if (offset === undefined) {
        throw this.#backpressure(
          'postBytes',
          `inbox ${JSON.stringify(memory.name)} cannot reserve ${captured.length} bytes.`,
        );
      }
      try {
        runtime.storage.writeInbox(inbox, offset, captured);
        const messageId = runtime.enqueueMessage(entry, [offset, captured.length]);
        this.#outstanding.set(messageId, {
          kind: 'postBytes',
          inbox,
          offset,
          length: captured.length,
        });
      } catch (cause) {
        this.#inbox.release(inbox, offset, captured.length);
        throw cause;
      }
    } catch (cause) {
      return Promise.reject(this.#operationError('postBytes', cause));
    }
    return Promise.resolve();
  }

  onOutput(output: OutputRef | BytesOutputRef, callback: unknown): Unsubscribe {
    this.#assertRegistration('onOutput');
    const ref = output as object;
    const definition = this.#outputDefinition(ref);
    if (definition === undefined) {
      throw messagingError(
        'device/output-unknown',
        this.#deviceId,
        'onOutput received an output that is not declared by this factory.',
      );
    }
    assertMessageCallback(callback, this.#deviceId, 'onOutput');
    if (this.#outputListeners.has(ref)) {
      throw messagingError(
        'device/output-consumer',
        this.#deviceId,
        `onOutput already has a consumer for ${JSON.stringify(definition.name)}.`,
      );
    }
    const listener = callback as OutputCallback;
    this.#outputListeners.set(ref, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#outputListeners.get(ref) === listener) {
        this.#outputListeners.delete(ref);
      }
    };
  }

  updateBytes(resource: BytesRef, offset: number, bytes: Uint8Array): Promise<void> {
    let captured: Uint8Array;
    try {
      this.#assertOpen('updateBytes');
      const memory = this.#memory(resource);
      if (
        memory === undefined ||
        memory.kind !== 'bytes' ||
        (!memory.writable && !this.#updateResources.has(memory.ref)) ||
        memory.layout.kind !== 'bytes'
      ) {
        throw messagingError(
          'device/update-target',
          this.#deviceId,
          'updateBytes requires a writable bytes resource or a host-authorized update resource declared by this factory.',
        );
      }
      const capacity = memory.layout.length;
      if (!Number.isInteger(offset) || offset < 0 || offset > capacity) {
        throw messagingError(
          'device/update-target',
          this.#deviceId,
          `updateBytes offset must be an integer in [0, ${capacity}].`,
        );
      }
      if (!(bytes instanceof Uint8Array)) {
        throw messagingError(
          'device/update-target',
          this.#deviceId,
          'updateBytes bytes must be a Uint8Array.',
        );
      }
      captured = new Uint8Array(bytes);
      if (offset + captured.length > capacity) {
        throw messagingError(
          'device/update-target',
          this.#deviceId,
          `updateBytes range [${offset}, ${offset + captured.length}) exceeds capacity ${capacity}.`,
        );
      }
      this.#requireRuntime('updateBytes');
    } catch (cause) {
      return Promise.reject(this.#operationError('updateBytes', cause));
    }
    return new Promise<void>((resolve, reject) => {
      const request: UpdateRequest = { ref: resource, offset, bytes: captured, resolve, reject };
      if (this.#executing || this.#draining) {
        if (this.#pendingUpdates.length >= this.#limits.updateCapacity) {
          reject(
            this.#backpressure(
              'updateBytes',
              `update queue has reached its ${this.#limits.updateCapacity}-request limit.`,
            ),
          );
          return;
        }
        this.#pendingUpdates.push(request);
        return;
      }
      this.#commitUpdate(request);
    });
  }

  deliver(port: string, payload: TopicPayload, meta: TopicMetadata): void {
    this.#assertOpen('deliver');
    const descriptor = this.#description.ports.get(port);
    if (descriptor === undefined) {
      throw messagingError(
        'device/topic-unknown',
        this.#deviceId,
        `deliver received unknown port ${JSON.stringify(port)}.`,
      );
    }
    if (descriptor.direction !== 'input') {
      throw messagingError(
        'device/topic-direction',
        this.#deviceId,
        `deliver requires an input port, but ${JSON.stringify(port)} is an output.`,
      );
    }
    const captured = captureTopicPayload(this.#deviceId, port, descriptor.type, payload);
    const capturedMeta = captureTopicMetadata(this.#deviceId, meta);
    const listeners = this.#subscriptions.get(port);
    if (listeners === undefined || listeners.length === 0) {
      return;
    }
    if (!this.#ready || this.#executing || this.#draining || this.#pendingInputs.length > 0) {
      if (this.#pendingInputs.length >= this.#limits.deliveryCapacity) {
        throw this.#backpressure(
          'deliver',
          `input queue for port ${JSON.stringify(port)} is full (${this.#limits.deliveryCapacity} messages).`,
        );
      }
      this.#pendingInputs.push({ port, payload: captured, meta: capturedMeta });
      return;
    }
    this.#deliverOne({ port, payload: captured, meta: capturedMeta });
  }

  #sendScalar(output: OutputRef, payload: readonly (boolean | number)[], timePs: number): boolean {
    this.#assertBridge();
    const definition = this.#outputDefinition(output as object);
    if (definition === undefined || definition.kind !== 'scalar-output') {
      throw messagingError(
        'device/output-unknown',
        this.#deviceId,
        'bridge.send received an output that is not declared by this factory.',
      );
    }
    const count = this.#outputCounts.get(output) ?? 0;
    if (count >= definition.capacity) {
      return false;
    }
    this.#outputQueue.push({
      kind: 'scalar',
      ref: output,
      payload: Object.freeze([...payload]),
      timePs,
    });
    this.#outputCounts.set(output, count + 1);
    return true;
  }

  #sendBytes(output: BytesOutputRef, bytes: Uint8Array, timePs: number): boolean {
    this.#assertBridge();
    const definition = this.#outputDefinition(output as object);
    if (definition === undefined || definition.kind !== 'bytes-output') {
      throw messagingError(
        'device/output-unknown',
        this.#deviceId,
        'bridge.send_bytes received an output that is not declared by this factory.',
      );
    }
    if (bytes.length > definition.maxBytes) {
      throw new RangeError(
        `bridge.send_bytes length ${bytes.length} exceeds maxBytes ${definition.maxBytes}`,
      );
    }
    const count = this.#outputCounts.get(output) ?? 0;
    if (count >= definition.capacity) {
      return false;
    }
    if (this.#outputBytes + bytes.length > this.#limits.outputByteBudget) {
      return false;
    }
    this.#outputQueue.push({
      kind: 'bytes',
      ref: output,
      bytes: new Uint8Array(bytes),
      timePs,
    });
    this.#outputCounts.set(output, count + 1);
    this.#outputBytes += bytes.length;
    return true;
  }

  #assertBridge(): void {
    if (this.#destroyed) {
      throw messagingError(
        'device/instance-destroyed',
        this.#deviceId,
        'bridge output is unavailable after destroy.',
      );
    }
    if (this.#closed) {
      throw messagingError(
        'device/not-active',
        this.#deviceId,
        'bridge output is unavailable because the instance was not activated.',
      );
    }
  }

  #drainOutputs(): void {
    if (this.#outputQueue.length === 0) return;
    let firstError: unknown;
    while (this.#outputQueue.length > 0) {
      const message = this.#outputQueue.shift()!;
      const count = (this.#outputCounts.get(message.ref) ?? 1) - 1;
      if (count <= 0) {
        this.#outputCounts.delete(message.ref);
      } else {
        this.#outputCounts.set(message.ref, count);
      }
      if (message.kind === 'bytes') {
        this.#outputBytes -= message.bytes.length;
      }
      const callback = this.#outputListeners.get(message.ref);
      if (callback === undefined) continue;
      try {
        const meta = Object.freeze({ timePs: message.timePs });
        if (message.kind === 'scalar') {
          this.#observeCallback(callback(Object.freeze([...message.payload]), meta));
        } else {
          this.#observeCallback(callback(new Uint8Array(message.bytes), meta));
        }
      } catch (cause) {
        firstError ??= cause;
        this.#localFault = true;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  #drainInputs(): void {
    let firstError: unknown;
    while (this.#pendingInputs.length > 0) {
      const message = this.#pendingInputs.shift()!;
      try {
        this.#deliverOne(message);
      } catch (cause) {
        firstError ??= cause;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  #deliverOne(message: InputMessage): void {
    const listeners = [...(this.#subscriptions.get(message.port) ?? [])];
    let firstError: unknown;
    for (const entry of listeners) {
      const current = this.#subscriptions.get(message.port);
      if (current === undefined || !current.includes(entry)) continue;
      try {
        const callback = entry.callback;
        this.#observeCallback(callback(cloneTopicPayload(message.payload), message.meta));
      } catch (cause) {
        firstError ??= cause;
        this.#localFault = true;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  #drainPublish(): void {
    if (this.#pendingPublish.length === 0) return;
    const sink = this.#onTopic;
    let firstError: unknown;
    while (this.#pendingPublish.length > 0) {
      const message = this.#pendingPublish.shift()!;
      if (sink === undefined) continue;
      try {
        const result: unknown = sink(
          Object.freeze({ port: message.port, payload: message.payload }),
        );
        if (result !== undefined) {
          consumeThenable(result);
          throw messagingError(
            'device/message-callback',
            this.#deviceId,
            'onTopic must return undefined.',
          );
        }
      } catch (cause) {
        firstError ??= cause;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  #flushUpdates(): void {
    while (this.#pendingUpdates.length > 0) {
      this.#commitUpdate(this.#pendingUpdates.shift()!);
    }
  }

  #commitUpdate(request: UpdateRequest): void {
    const runtime = this.#runtime;
    if (runtime === undefined) {
      request.reject(
        messagingError(
          'device/instance-destroyed',
          this.#deviceId,
          'updateBytes could not commit because the instance is no longer active.',
        ),
      );
      return;
    }
    try {
      runtime.storage.updateBytesFromBytes(request.ref, request.offset, request.bytes);
      request.resolve();
    } catch (cause) {
      request.reject(
        messagingError(
          'device/update-target',
          this.#deviceId,
          'updateBytes could not commit its captured bytes.',
          cause,
        ),
      );
    }
  }

  #rejectUpdates(code: 'device/not-active' | 'device/instance-destroyed'): void {
    const reason = messagingError(
      code,
      this.#deviceId,
      code === 'device/instance-destroyed'
        ? 'updateBytes was cancelled by destroy.'
        : 'updateBytes was cancelled because the instance was not activated.',
    );
    for (const request of this.#pendingUpdates.splice(0)) {
      request.reject(reason);
    }
  }

  #releaseOutstanding(messageId: number): void {
    if (messageId === 0) return;
    const outstanding = this.#outstanding.get(messageId);
    if (outstanding === undefined) return;
    this.#outstanding.delete(messageId);
    if (outstanding.kind === 'postBytes') {
      this.#inbox.release(outstanding.inbox, outstanding.offset, outstanding.length);
    }
  }

  #observeCallback(result: unknown): void {
    if (!isThenable(result)) return;
    void Promise.resolve(result).catch(() => {
      this.#localFault = true;
    });
  }

  #outputDefinition(ref: object): OutputDefinition | undefined {
    return this.#outputMap.get(ref) ?? this.#module.outputs.find((output) => output.ref === ref);
  }

  #entryDefinition(
    entry: EntryRef,
    operation: string,
  ): FunctionDefinition & { readonly category: 'entry' } {
    const definition =
      this.#functionMap.get(entry as object) ??
      this.#module.functions.find((fn) => fn.ref === entry);
    if (definition === undefined || definition.category !== 'entry') {
      throw messagingError(
        'device/message-target',
        this.#deviceId,
        `${operation} target must be an ordinary entry declared by this factory.`,
      );
    }
    return definition as FunctionDefinition & { readonly category: 'entry' };
  }

  #captureArgs(
    definition: FunctionDefinition,
    args: readonly (boolean | number)[],
  ): readonly RuntimeScalar[] {
    if (!Array.isArray(args) || args.length !== definition.params.length) {
      throw messagingError(
        'device/message-target',
        this.#deviceId,
        `post arguments must match the ${definition.params.length}-argument signature of ${JSON.stringify(definition.name)}.`,
      );
    }
    const captured = definition.params.map((type, index) => {
      const value = args[index];
      if (!isPostScalar(type, value)) {
        throw messagingError(
          'device/message-target',
          this.#deviceId,
          `post argument ${index} of ${JSON.stringify(definition.name)} must be a valid ${type} scalar.`,
        );
      }
      return value;
    });
    return Object.freeze(captured);
  }

  #inboxMemory(inbox: InboxRef): MemoryDefinition {
    const memory =
      this.#memoryMap.get(inbox as object) ??
      this.#module.memories.find((entry) => entry.ref === inbox);
    if (memory === undefined || memory.kind !== 'inbox') {
      throw messagingError(
        'device/inbox-reference',
        this.#deviceId,
        'postBytes inbox must be an inbox declared by this factory.',
      );
    }
    return memory;
  }

  #memory(ref: BytesRef): MemoryDefinition | undefined {
    return (
      this.#memoryMap.get(ref as object) ??
      this.#module.memories.find((memory) => memory.ref === ref)
    );
  }

  #assertOpen(operation: string): void {
    if (this.#destroyed) {
      throw messagingError(
        'device/instance-destroyed',
        this.#deviceId,
        `${operation} is unavailable after destroy.`,
      );
    }
    if (this.#closed) {
      throw messagingError(
        'device/not-active',
        this.#deviceId,
        `${operation} is unavailable because the instance was not activated.`,
      );
    }
    if (this.#localFault || this.#runtime?.isFaulted() === true) {
      throw messagingError(
        'device/instance-busy',
        this.#deviceId,
        `${operation} is unavailable while the instance is faulted.`,
      );
    }
  }

  #assertRegistration(operation: string): void {
    this.#assertOpen(operation);
    if (!this.#registrationsOpen) {
      throw messagingError(
        'device/factory-closed',
        this.#deviceId,
        `${operation} registration is closed after the factory returned.`,
      );
    }
  }

  #assertReady(operation: string): void {
    this.#assertOpen(operation);
    if (!this.#ready || this.#runtime === undefined) {
      throw messagingError(
        'device/not-active',
        this.#deviceId,
        `${operation} is unavailable until initialize completes.`,
      );
    }
  }

  #requireRuntime(operation: string): MessagingRuntime {
    this.#assertReady(operation);
    return this.#runtime!;
  }

  #operationError(operation: string, cause: unknown): unknown {
    if (cause instanceof BackpressureError) return cause;
    if (cause instanceof DeviceError) return cause;
    return messagingError(
      'device/instance-busy',
      this.#deviceId,
      `${operation} was rejected before admission.`,
      cause,
    );
  }

  #backpressure(operation: BackpressureOperation, detail: string): BackpressureError {
    return new BackpressureError(operation, `Device ${JSON.stringify(this.#deviceId)} ${detail}`);
  }
}

export function resolveMessagingOptions(value: unknown, deviceId: string): ResolvedMessagingLimits {
  if (value === undefined) return { ...DEFAULT_LIMITS };
  if (!isPlainRecord(value)) {
    throw messagingError(
      'device/instance-invalid',
      deviceId,
      'messaging options must be an object.',
    );
  }
  const allowed = new Set([
    'postCapacity',
    'publishCapacity',
    'deliveryCapacity',
    'updateCapacity',
    'outputByteBudget',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw messagingError(
        'device/instance-invalid',
        deviceId,
        `messaging options contain unknown field ${JSON.stringify(key)}.`,
      );
    }
  }
  const read = (key: keyof ResolvedMessagingLimits, allowZero: boolean): number => {
    const raw = value[key];
    if (raw === undefined) return DEFAULT_LIMITS[key];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < (allowZero ? 0 : 1)) {
      throw messagingError(
        'device/instance-invalid',
        deviceId,
        `messaging ${key} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`,
      );
    }
    return raw;
  };
  return Object.freeze({
    postCapacity: read('postCapacity', false),
    publishCapacity: read('publishCapacity', false),
    deliveryCapacity: read('deliveryCapacity', false),
    updateCapacity: read('updateCapacity', false),
    outputByteBudget: read('outputByteBudget', true),
  });
}

function assertMessageCallback(
  callback: unknown,
  deviceId: string,
  operation: string,
): asserts callback is (...args: never[]) => unknown {
  const kind = callableKind(callback);
  if (kind !== 'function' && kind !== 'async') {
    throw messagingError(
      'device/message-callback',
      deviceId,
      `${operation} callback must be a function or async function.`,
    );
  }
}

const INTEGER_RANGES = Object.freeze({
  u8: [0, 0xff],
  u16: [0, 0xffff],
  u32: [0, 0xffff_ffff],
  i8: [-0x80, 0x7f],
  i16: [-0x8000, 0x7fff],
  i32: [-0x8000_0000, 0x7fff_ffff],
} as const);

function isPostScalar(type: ScalarType, value: unknown): value is boolean | number {
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'f32' || type === 'f64') return typeof value === 'number';
  const range = INTEGER_RANGES[type as keyof typeof INTEGER_RANGES];
  return (
    range !== undefined &&
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= range[0] &&
    value <= range[1]
  );
}
