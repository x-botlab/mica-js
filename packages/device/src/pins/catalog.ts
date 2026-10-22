import type { IRModule } from '@mica-js/ir';
import { DeviceError } from '../errors';
import type { DevicePinDescriptor, PinRef } from '../types';

/** Instance-scoped mapping between declared pin ids, IR static refs and descriptors. */
export class PinCatalog {
  readonly #descriptors: ReadonlyMap<string, DevicePinDescriptor>;
  readonly #refs = new Map<string, PinRef>();
  readonly #byRef = new Map<PinRef, DevicePinDescriptor>();

  constructor(descriptors: ReadonlyMap<string, DevicePinDescriptor>) {
    this.#descriptors = descriptors;
  }

  declare(module: IRModule, id: unknown, deviceId: string): PinRef {
    if (typeof id !== 'string' || id.length === 0) {
      throw new DeviceError(
        'device/pin-unknown',
        `Device ${JSON.stringify(deviceId)} requires a non-empty pin id.`,
        { deviceId },
      );
    }
    const descriptor = this.#descriptors.get(id);
    if (descriptor === undefined) {
      throw new DeviceError(
        'device/pin-unknown',
        `Device ${JSON.stringify(deviceId)} does not declare pin ${JSON.stringify(id)}.`,
        { deviceId },
      );
    }
    const existing = this.#refs.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const ref = module.domainDeclaration('pin', id);
    this.#refs.set(id, ref);
    this.#byRef.set(ref, descriptor);
    return ref;
  }

  descriptor(ref: PinRef): DevicePinDescriptor | undefined {
    return this.#byRef.get(ref);
  }

  byName(id: string): DevicePinDescriptor | undefined {
    return this.#descriptors.get(id);
  }
}
