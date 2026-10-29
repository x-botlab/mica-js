import type { IRModule } from '@mica-js/ir';
import { DeviceError } from '../errors';
import { isPlainRecord } from '../internal/records';
import type { FifoDescriptor, FifoRef } from '../types';

export interface FifoDeclaration {
  readonly name: string;
  readonly ref: FifoRef;
  readonly maxRecord: number;
  readonly length: number;
}

/**
 * RFC 0017 record queues, declared during the factory and reached only through the step hooks.
 *
 * `api.ir.fifo` registers a domain declaration on the module, so the name shares the module's
 * declaration namespace and the declaration sits next to the device's other static refs. The
 * records themselves live in {@link FifoRuntime}, one set per instance.
 */
export class FifoDomain {
  readonly #deviceId: string;
  readonly #byName = new Map<string, FifoDeclaration>();

  constructor(deviceId: string) {
    this.#deviceId = deviceId;
  }

  /** Declares one queue; repeating a name with the same capacity returns the first declaration. */
  declare(module: IRModule, name: unknown, descriptor: unknown): FifoRef {
    if (typeof name !== 'string' || name.length === 0) {
      throw new DeviceError(
        'device/fifo-unknown',
        `Device ${JSON.stringify(this.#deviceId)} requires a non-empty fifo name.`,
        { deviceId: this.#deviceId },
      );
    }
    const { maxRecord, length } = readDescriptor(descriptor, name, this.#deviceId);
    const existing = this.#byName.get(name);
    if (existing !== undefined) {
      if (existing.maxRecord !== maxRecord || existing.length !== length) {
        throw new DeviceError(
          'device/fifo-descriptor',
          `Device ${JSON.stringify(this.#deviceId)} redeclared fifo ${JSON.stringify(name)} with a different capacity.`,
          { deviceId: this.#deviceId },
        );
      }
      return existing.ref;
    }
    const ref = declareDomainName(module, name, this.#deviceId);
    this.#byName.set(name, { name, ref, maxRecord, length });
    return ref;
  }

  get(name: string): FifoDeclaration | undefined {
    return this.#byName.get(name);
  }

  /** Fresh, empty queues for one instance. */
  createRuntime(): FifoRuntime {
    return new FifoRuntime();
  }
}

/** Per-instance records of every declared queue. */
export class FifoRuntime {
  readonly #records = new Map<string, Uint8Array[]>();

  /** Appends one record; `false` when the queue is at capacity. */
  write(declaration: FifoDeclaration, bytes: Uint8Array): boolean {
    const records = this.#bucket(declaration);
    if (records.length >= declaration.length) {
      return false;
    }
    records.push(new Uint8Array(bytes));
    return true;
  }

  /** Takes every committed record, in write order, and empties the queue. */
  drain(declaration: FifoDeclaration): readonly Uint8Array[] {
    const records = this.#bucket(declaration);
    if (records.length === 0) {
      return Object.freeze([]);
    }
    const drained = records.map((record) => new Uint8Array(record));
    records.length = 0;
    return Object.freeze(drained);
  }

  #bucket(declaration: FifoDeclaration): Uint8Array[] {
    let records = this.#records.get(declaration.name);
    if (records === undefined) {
      records = [];
      this.#records.set(declaration.name, records);
    }
    return records;
  }
}

function readDescriptor(
  value: unknown,
  name: string,
  deviceId: string,
): Pick<FifoDescriptor, 'maxRecord' | 'length'> {
  if (!isPlainRecord(value)) {
    throw new DeviceError(
      'device/fifo-descriptor',
      `Device ${JSON.stringify(deviceId)} fifo ${JSON.stringify(name)} requires a descriptor object.`,
      { deviceId },
    );
  }
  const maxRecord = value['maxRecord'];
  const length = value['length'];
  if (!isPositiveInteger(maxRecord) || !isPositiveInteger(length)) {
    throw new DeviceError(
      'device/fifo-descriptor',
      `Device ${JSON.stringify(deviceId)} fifo ${JSON.stringify(name)} requires positive integer maxRecord and length.`,
      { deviceId },
    );
  }
  return { maxRecord, length };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The declaration shares the module's namespace, so a clash with state/bytes fails here. */
function declareDomainName(module: IRModule, name: string, deviceId: string): FifoRef {
  try {
    return module.domainDeclaration('fifo', name);
  } catch (cause) {
    throw new DeviceError(
      'device/fifo-descriptor',
      `Device ${JSON.stringify(deviceId)} could not declare fifo ${JSON.stringify(name)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { deviceId, cause },
    );
  }
}
