import { TopicInbox, resolveDelivery, timePs } from '@mica-js/core';
import {
  FLOAT_TYPES,
  fromNumber,
  toNumber,
  type FloatBits,
  type FloatType,
  type IRModule,
  type IRStorage,
  type MemoryDefinition,
  type ReadableBytesRef,
  type RuntimeScalar,
  type StateRef,
} from '@mica-js/ir';
import type { ValidatedBindings } from '../factory/bindings';
import { captureTopicPayload } from '../messaging/payload';
import type {
  DeviceDescription,
  DeviceDiagnostic,
  DeviceDiagnosticCode,
  DeviceInputIO,
  DeviceOutputIO,
  DevicePortDescriptor,
  TopicMetadata,
  TopicPayload,
} from '../types';
import { FifoDomain, type FifoDeclaration, type FifoRuntime } from './fifo';

export interface DeviceStepHooksOptions {
  readonly deviceId: string;
  readonly description: DeviceDescription;
  readonly module: IRModule;
  /** Resolved lazily: the instance's storage guards against use after destroy. */
  readonly storage: () => IRStorage;
  readonly publish: (port: string, payload: TopicPayload) => void;
  readonly bindings: ValidatedBindings;
  readonly fifos: FifoDomain;
  /** Pending records one `message` port keeps before it reports backpressure. */
  readonly deliveryCapacity: number;
  readonly onDiagnostic?: (diagnostic: DeviceDiagnostic) => void;
}

/**
 * Device half of the RFC 0017 step contract: stages what `deliver` posted and runs the factory's
 * `applyInputs` / `flushOutputs` hooks with the `io` views.
 *
 * Every `io` method validates its reference at call time and reports a diagnostic instead of
 * throwing, so a device that misuses `io` keeps the simulation running. Hook exceptions are not
 * caught here: RFC 0017 has the host isolate them.
 */
export class DeviceStepHooks {
  readonly #deviceId: string;
  readonly #description: DeviceDescription;
  readonly #storage: () => IRStorage;
  readonly #publishToHost: (port: string, payload: TopicPayload) => void;
  readonly #applyInputs: ((io: DeviceInputIO) => void) | undefined;
  readonly #flushOutputs: ((io: DeviceOutputIO) => void) | undefined;
  readonly #fifos: FifoDomain;
  readonly #fifoRuntime: FifoRuntime;
  readonly #deliveryCapacity: number;
  readonly #onDiagnostic: ((diagnostic: DeviceDiagnostic) => void) | undefined;
  readonly #memories = new Map<string, MemoryDefinition>();
  readonly #inboxes = new Map<string, TopicInbox<TopicPayload>>();
  readonly #usedPorts = new Set<string>();
  readonly #inputIO: DeviceInputIO;
  readonly #outputIO: DeviceOutputIO;
  #coverageReported = false;

  constructor(options: DeviceStepHooksOptions) {
    this.#deviceId = options.deviceId;
    this.#description = options.description;
    this.#storage = options.storage;
    this.#publishToHost = options.publish;
    this.#applyInputs = options.bindings.applyInputs;
    this.#flushOutputs = options.bindings.flushOutputs;
    this.#fifos = options.fifos;
    this.#fifoRuntime = options.fifos.createRuntime();
    this.#deliveryCapacity = options.deliveryCapacity;
    this.#onDiagnostic = options.onDiagnostic;
    for (const memory of options.module.memories) {
      this.#memories.set(memory.name, memory);
    }
    this.#inputIO = Object.freeze({
      takeInput: (port: string): TopicPayload | undefined => this.#inbox(port)?.takeInput(),
      takeInputs: (port: string): readonly TopicPayload[] => {
        const inbox = this.#inbox(port);
        if (inbox === undefined) {
          return Object.freeze([]);
        }
        return Object.freeze(inbox.takeInputs().map((record) => record.payload));
      },
      writeState: (name: string, value: boolean | number): void => this.#writeState(name, value),
      writeFifo: (name: string, bytes: Uint8Array): boolean => this.#writeFifo(name, bytes),
      report: (code: string, detail?: string): void =>
        this.#report(code, detail ?? 'Device reported a diagnostic.'),
    });
    this.#outputIO = Object.freeze({
      readState: (name: string): boolean | number | undefined => this.#readState(name),
      readBytes: (name: string): Uint8Array => this.#readBytes(name),
      readFifo: (name: string): readonly Uint8Array[] => this.#readFifo(name),
      publish: (port: string, payload: TopicPayload): void => this.#publish(port, payload),
      publishBytes: (port: string, bytes: Uint8Array): void => this.#publish(port, bytes),
    });
  }

  /** True when the factory declared at least one step hook. */
  static isUsed(bindings: ValidatedBindings): boolean {
    return bindings.applyInputs !== undefined || bindings.flushOutputs !== undefined;
  }

  /** Stages one delivery for the step that is starting; only devices with `applyInputs` need it. */
  stage(port: string, payload: TopicPayload, meta: TopicMetadata): void {
    if (this.#applyInputs === undefined) {
      return; // Nothing would read the record; callback-style devices use `subscribe` instead.
    }
    const descriptor = this.#description.ports.get(port);
    if (descriptor === undefined || descriptor.direction !== 'input') {
      return; // `deliver` validated the target before staging.
    }
    this.#inboxFor(port, descriptor).post({
      // The device may mutate what it reads, so bytes are captured per delivery.
      payload: captureTopicPayload(this.#deviceId, port, descriptor.type, payload),
      simTime: timePs(meta.simTime),
    });
  }

  /** Runs `applyInputs`, then ends the step so the next one starts from an empty record set. */
  applyInputs(): void {
    try {
      this.#applyInputs?.(this.#inputIO);
    } finally {
      for (const inbox of this.#inboxes.values()) {
        inbox.endStep();
      }
    }
  }

  /** Runs `flushOutputs`, then reports the ports the hook contract never touched. */
  flushOutputs(): void {
    this.#flushOutputs?.(this.#outputIO);
    this.#reportUnusedPorts();
  }

  /** Drops staged deliveries, e.g. when the instance resets before the next step. */
  clearPending(): void {
    for (const inbox of this.#inboxes.values()) {
      inbox.endStep();
    }
  }

  #inbox(port: string): TopicInbox<TopicPayload> | undefined {
    const descriptor = this.#description.ports.get(port);
    if (descriptor === undefined) {
      this.#report(
        'device/topic-unknown',
        `takeInput received unknown port ${JSON.stringify(port)}.`,
        {
          port,
        },
      );
      return undefined;
    }
    if (descriptor.direction !== 'input') {
      this.#report(
        'device/topic-direction',
        `Port ${JSON.stringify(port)} is an output; only input ports deliver into a step.`,
        { port },
      );
      return undefined;
    }
    this.#usedPorts.add(port);
    return this.#inboxFor(port, descriptor);
  }

  #inboxFor(port: string, descriptor: DevicePortDescriptor): TopicInbox<TopicPayload> {
    let inbox = this.#inboxes.get(port);
    if (inbox === undefined) {
      inbox = new TopicInbox<TopicPayload>({
        delivery: resolveDelivery(descriptor.delivery, descriptor.type),
        capacity: this.#deliveryCapacity,
        port,
        onDiagnostic: (diagnostic) => this.#report(diagnostic.code, diagnostic.message, { port }),
      });
      this.#inboxes.set(port, inbox);
    }
    return inbox;
  }

  #writeState(name: string, value: boolean | number): void {
    const memory = this.#memory(name);
    if (memory === undefined) {
      return;
    }
    if (memory.kind !== 'state' || memory.layout.kind !== 'scalar') {
      this.#report('device/memory-kind', `${JSON.stringify(name)} is not a scalar state.`, {
        memory: name,
      });
      return;
    }
    const type = memory.layout.scalarType;
    const prepared = this.#scalarValue(type, value, name);
    if (prepared === undefined) {
      return;
    }
    try {
      this.#storage().storeState(memory.ref as StateRef, prepared);
    } catch (cause) {
      this.#report(
        'device/memory-type',
        `${JSON.stringify(name)} rejected the value: ${describe(cause)}`,
        {
          memory: name,
        },
      );
    }
  }

  #readState(name: string): boolean | number | undefined {
    const memory = this.#memory(name);
    if (memory === undefined) {
      return undefined;
    }
    if (memory.kind !== 'state' || memory.layout.kind !== 'scalar') {
      this.#report('device/memory-kind', `${JSON.stringify(name)} is not a scalar state.`, {
        memory: name,
      });
      return undefined;
    }
    const value = this.#storage().loadState(memory.ref as StateRef) as boolean | number | FloatBits;
    return typeof value === 'object' && value !== null ? toNumber(value) : value;
  }

  #readBytes(name: string): Uint8Array {
    const memory = this.#memory(name);
    if (memory === undefined) {
      return new Uint8Array(0);
    }
    if (memory.kind !== 'bytes' || memory.layout.kind !== 'bytes') {
      this.#report('device/memory-kind', `${JSON.stringify(name)} is not a byte memory.`, {
        memory: name,
      });
      return new Uint8Array(0);
    }
    return this.#storage().readVersionedBytes(
      memory.ref as ReadableBytesRef,
      0,
      memory.layout.length,
    ).bytes;
  }

  #writeFifo(name: string, bytes: Uint8Array): boolean {
    const declaration = this.#fifo(name);
    if (declaration === undefined) {
      return false;
    }
    if (!(bytes instanceof Uint8Array)) {
      this.#report(
        'device/memory-type',
        `Fifo ${JSON.stringify(name)} requires a Uint8Array record.`,
        {
          memory: name,
        },
      );
      return false;
    }
    if (bytes.length > declaration.maxRecord) {
      this.#report(
        'device/fifo-record',
        `Fifo ${JSON.stringify(name)} accepts at most ${declaration.maxRecord} bytes per record.`,
        { memory: name },
      );
      return false;
    }
    return this.#fifoRuntime.write(declaration, bytes);
  }

  #readFifo(name: string): readonly Uint8Array[] {
    const declaration = this.#fifo(name);
    return declaration === undefined ? Object.freeze([]) : this.#fifoRuntime.drain(declaration);
  }

  #fifo(name: string): FifoDeclaration | undefined {
    const declaration = this.#fifos.get(name);
    if (declaration === undefined) {
      this.#report(
        this.#memories.has(name) ? 'device/memory-kind' : 'device/memory-unknown',
        this.#memories.has(name)
          ? `${JSON.stringify(name)} is not a fifo.`
          : `Fifo ${JSON.stringify(name)} is not declared.`,
        { memory: name },
      );
    }
    return declaration;
  }

  #publish(port: string, payload: TopicPayload): void {
    const descriptor = this.#description.ports.get(port);
    if (descriptor === undefined) {
      this.#report(
        'device/topic-unknown',
        `publish received unknown port ${JSON.stringify(port)}.`,
        { port },
      );
      return;
    }
    if (descriptor.direction !== 'output') {
      this.#report(
        'device/topic-direction',
        `Port ${JSON.stringify(port)} is an input; only output ports can publish.`,
        { port },
      );
      return;
    }
    this.#usedPorts.add(port);
    try {
      this.#publishToHost(port, payload);
    } catch (cause) {
      this.#report(
        'device/topic-rejected',
        `Port ${JSON.stringify(port)} rejected the payload: ${describe(cause)}`,
        {
          port,
        },
      );
    }
  }

  /** Covers the RFC 0017 rule: a hook-declared port that is never used is reported once. */
  #reportUnusedPorts(): void {
    if (this.#coverageReported) {
      return;
    }
    this.#coverageReported = true;
    for (const [port, descriptor] of this.#description.ports) {
      if (this.#usedPorts.has(port)) {
        continue;
      }
      if (descriptor.direction === 'input' && this.#applyInputs === undefined) {
        continue;
      }
      if (descriptor.direction === 'output' && this.#flushOutputs === undefined) {
        continue;
      }
      this.#report(
        'device/port-unused',
        `Declared ${descriptor.direction} port ${JSON.stringify(port)} was never ${descriptor.direction === 'input' ? 'read' : 'published'} by the step hooks.`,
        { port },
      );
    }
  }

  #memory(name: string): MemoryDefinition | undefined {
    const memory = this.#memories.get(name);
    if (memory === undefined) {
      this.#report('device/memory-unknown', `Memory ${JSON.stringify(name)} is not declared.`, {
        memory: name,
      });
    }
    return memory;
  }

  #scalarValue(type: string, value: boolean | number, name: string): RuntimeScalar | undefined {
    if (type === 'bool') {
      if (typeof value !== 'boolean') {
        this.#report('device/memory-type', `State ${JSON.stringify(name)} expects a boolean.`, {
          memory: name,
        });
        return undefined;
      }
      return value;
    }
    if (typeof value !== 'number') {
      this.#report('device/memory-type', `State ${JSON.stringify(name)} expects a number.`, {
        memory: name,
      });
      return undefined;
    }
    if ((FLOAT_TYPES as readonly string[]).includes(type)) {
      return fromNumber(type as FloatType, value);
    }
    return value;
  }

  #report(
    code: DeviceDiagnosticCode | (string & {}),
    message: string,
    extra: { readonly port?: string; readonly memory?: string } = {},
  ): void {
    try {
      this.#onDiagnostic?.({
        code,
        message,
        deviceId: this.#deviceId,
        ...(extra.port === undefined ? {} : { port: extra.port }),
        ...(extra.memory === undefined ? {} : { memory: extra.memory }),
      });
    } catch {
      // A throwing diagnostic sink must not break the step.
    }
  }
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
