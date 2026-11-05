import {
  createDeviceRegistry,
  formatDeviceReference,
  parseDeviceReference,
  type DeviceReference,
  type DeviceRegistry,
  type DeviceSymbolProvider,
} from '@mica-js/document/schematic';
import type { IDisposable } from '@mica-js/core/lifecycle';
import { createDecorator } from '../instantiation';
import { IDeviceLibraryResolver } from '../libraries';
import type { IDeviceLibrary } from '../providers';

export interface ISchematicDevices extends DeviceSymbolProvider, IDisposable {
  prepare(ids: readonly string[]): Promise<void>;
}

export const ISchematicDevices = createDecorator<ISchematicDevices>('editor.schematicDevices');

export class SchematicDevices implements ISchematicDevices {
  readonly #registries = new Map<string, DeviceRegistry>();
  readonly #pending = new Map<string, Promise<void>>();
  #disposed = false;

  constructor(@IDeviceLibraryResolver private readonly library: IDeviceLibrary) {}

  async prepare(ids: readonly string[]): Promise<void> {
    this.#assertActive();
    await Promise.all([...new Set(ids)].map((id) => this.#prepare(id)));
  }

  getDeviceSymbol(reference: DeviceReference) {
    return this.#registry(reference)?.getDeviceSymbol(reference);
  }

  getDeviceName(reference: DeviceReference) {
    return this.#registry(reference)?.getDeviceName(reference);
  }

  getDeviceDesignatorPrefix(reference: DeviceReference) {
    return this.#registry(reference)?.getDeviceDesignatorPrefix?.(reference);
  }

  getDevicePropertyDescriptors(reference: DeviceReference) {
    return this.#registry(reference)?.getDevicePropertyDescriptors?.(reference);
  }

  dispose(): void {
    this.#disposed = true;
    this.#registries.clear();
    this.#pending.clear();
  }

  #registry(reference: DeviceReference): DeviceRegistry | undefined {
    return this.#registries.get(formatDeviceReference(reference.packageId, reference.deviceId));
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Schematic devices service is disposed.');
  }

  #prepare(id: string): Promise<void> {
    const reference = parseDeviceReference(id);
    if (!reference) return Promise.reject(new Error(`Invalid device ID ${JSON.stringify(id)}.`));
    if (reference.packageId === 'builtin' || this.#registries.has(id)) return Promise.resolve();
    const existing = this.#pending.get(id);
    if (existing) return existing;

    const pending = Promise.resolve()
      .then(() => {
        this.#assertActive();
        return this.library.resolve(id);
      })
      .then((description) => {
        this.#assertActive();
        if (!description) throw new Error(`Device ${JSON.stringify(id)} was not found.`);
        const definition = description.definition;
        const registry = createDeviceRegistry([
          {
            packageId: reference.packageId,
            devices: [
              {
                id: reference.deviceId,
                ...(definition.displayName === undefined
                  ? {}
                  : { displayName: definition.displayName }),
                ...(definition.description === undefined
                  ? {}
                  : { description: definition.description }),
                ...(definition.designatorPrefix === undefined
                  ? {}
                  : { designatorPrefix: definition.designatorPrefix }),
                raw: { ...definition },
              },
            ],
          },
        ]);
        this.#registries.set(id, registry);
      })
      .finally(() => {
        this.#pending.delete(id);
      });
    this.#pending.set(id, pending);
    return pending;
  }
}
