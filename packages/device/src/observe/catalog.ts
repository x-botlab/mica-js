import { IRConstructionError, type IRModule, type ScalarType } from '@mica-js/ir';
import { DeviceError } from '../errors';
import { isPlainRecord } from '../internal/records';
import type { PinCatalog } from '../pins/catalog';
import type { ObserverRef, PinRef } from '../types';

const DESCRIPTOR_FIELDS = new Set(['trigger', 'captures', 'target']);

export interface ObserverDescriptor {
  readonly ref: ObserverRef;
  readonly key: string;
  readonly trigger: PinRef;
  readonly triggerKey: string;
  readonly captures: readonly PinRef[];
  readonly captureKeys: readonly string[];
  readonly target: object;
}

/** Instance-scoped mapping between declared observation names and their IR static refs. */
export class ObserveCatalog {
  readonly #pins: PinCatalog;
  readonly #deviceId: string;
  readonly #byName = new Map<string, ObserverDescriptor>();
  readonly #byRef = new Map<ObserverRef, ObserverDescriptor>();
  readonly #order: ObserverDescriptor[] = [];

  constructor(pins: PinCatalog, deviceId: string) {
    this.#pins = pins;
    this.#deviceId = deviceId;
  }

  declare(module: IRModule, name: unknown, descriptor: unknown): ObserverRef {
    if (typeof name !== 'string' || name.length === 0) {
      throw bindingError(this.#deviceId, 'observation name must be a non-empty string');
    }
    if (this.#byName.has(name)) {
      throw bindingError(this.#deviceId, `observation ${JSON.stringify(name)} is declared twice`);
    }
    if (!isPlainRecord(descriptor)) {
      throw bindingError(
        this.#deviceId,
        `observation ${JSON.stringify(name)} requires a descriptor object`,
      );
    }
    for (const field of Object.keys(descriptor)) {
      if (!DESCRIPTOR_FIELDS.has(field)) {
        throw bindingError(
          this.#deviceId,
          `observation ${JSON.stringify(name)} has unknown field ${JSON.stringify(field)}`,
        );
      }
    }
    const trigger = this.#signalPin(name, descriptor['trigger'], 'trigger');
    const rawCaptures = descriptor['captures'];
    if (!Array.isArray(rawCaptures)) {
      throw bindingError(
        this.#deviceId,
        `observation ${JSON.stringify(name)} captures must be an array`,
      );
    }
    const captures = rawCaptures.map((capture, index) =>
      this.#signalPin(name, capture, `captures[${index}]`),
    );
    const target = descriptor['target'];
    if (typeof target !== 'object' || target === null) {
      throw bindingError(
        this.#deviceId,
        `observation ${JSON.stringify(name)} requires an entry target`,
      );
    }
    const targetFunction = module.functions.find((candidate) => candidate.ref === target);
    if (targetFunction !== undefined && targetFunction.category !== 'entry') {
      throw bindingError(
        this.#deviceId,
        `observation ${JSON.stringify(name)} target must be an ordinary entry`,
      );
    }
    let ref: ObserverRef;
    try {
      ref = module.domainDeclaration('observe', name) as ObserverRef;
    } catch (cause) {
      throw bindingError(
        this.#deviceId,
        `observation ${JSON.stringify(name)} could not be declared`,
        cause,
      );
    }
    const entry: ObserverDescriptor = Object.freeze({
      ref,
      key: name,
      trigger,
      triggerKey: this.#pins.descriptor(trigger)!.key,
      captures: Object.freeze(captures),
      captureKeys: Object.freeze(captures.map((pin) => this.#pins.descriptor(pin)!.key)),
      target: target as object,
    });
    this.#byName.set(name, entry);
    this.#byRef.set(ref, entry);
    this.#order.push(entry);
    return ref;
  }

  descriptor(ref: ObserverRef): ObserverDescriptor | undefined {
    return this.#byRef.get(ref);
  }

  pinKey(ref: PinRef): string | undefined {
    return this.#pins.descriptor(ref)?.key;
  }

  entries(): readonly ObserverDescriptor[] {
    return this.#order;
  }

  /** Link-time target signature check. Declarations may appear after their target entry. */
  validate(module: IRModule): void {
    for (const descriptor of this.#order) {
      const fn = module.functions.find((candidate) => candidate.ref === descriptor.target);
      if (fn === undefined) {
        throw bindingError(
          this.#deviceId,
          `observation ${JSON.stringify(descriptor.key)} target is not declared by this device`,
        );
      }
      if (fn.category !== 'entry') {
        throw bindingError(
          this.#deviceId,
          `observation ${JSON.stringify(descriptor.key)} target must be an ordinary entry`,
        );
      }
      const expected: readonly ScalarType[] = [
        'u8',
        ...descriptor.captureKeys.map(() => 'u32' as const),
      ];
      if (
        fn.params.length !== expected.length ||
        fn.params.some((type, index) => type !== expected[index])
      ) {
        throw bindingError(
          this.#deviceId,
          `observation ${JSON.stringify(descriptor.key)} target ${JSON.stringify(fn.name)} must accept [u8${descriptor.captureKeys.map(() => ', u32').join('')}] but declares [${fn.params.join(', ')}]`,
        );
      }
    }
  }

  #signalPin(observation: string, value: unknown, role: string): PinRef {
    if (typeof value !== 'object' || value === null) {
      throw pinError(
        this.#deviceId,
        `observation ${JSON.stringify(observation)} ${role} must be a pin reference`,
      );
    }
    const pin = value as PinRef;
    const descriptor = this.#pins.descriptor(pin);
    if (descriptor === undefined) {
      throw pinError(
        this.#deviceId,
        `observation ${JSON.stringify(observation)} ${role} is not a pin declared by this device`,
      );
    }
    if (descriptor.kind !== 'signal') {
      throw pinError(
        this.#deviceId,
        `observation ${JSON.stringify(observation)} ${role} ${JSON.stringify(descriptor.key)} is a ${descriptor.kind} pin and has no digital level`,
      );
    }
    return pin;
  }
}

export function bindingError(deviceId: string, message: string, cause?: unknown): DeviceError {
  return new DeviceError(
    'device/observe-binding',
    `Device ${JSON.stringify(deviceId)} ${message}.`,
    {
      deviceId,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

export function pinError(deviceId: string, message: string, cause?: unknown): DeviceError {
  return new DeviceError('device/observe-pin', `Device ${JSON.stringify(deviceId)} ${message}.`, {
    deviceId,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function observeConfigError(
  deviceId: string,
  message: string,
  cause?: unknown,
): DeviceError {
  return new DeviceError(
    'device/observe-config',
    `Device ${JSON.stringify(deviceId)} ${message}.`,
    { deviceId, ...(cause === undefined ? {} : { cause }) },
  );
}

export function observeUnavailableError(
  deviceId: string,
  message: string,
  cause?: unknown,
): DeviceError {
  return new DeviceError(
    'device/observe-unavailable',
    `Device ${JSON.stringify(deviceId)} ${message}.`,
    { deviceId, ...(cause === undefined ? {} : { cause }) },
  );
}

export function constructionMessage(error: unknown): string {
  if (error instanceof IRConstructionError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
