/**
 * Sensor factory registry (#192).
 *
 * Concrete sensor kinds are not part of the base architecture: a package (or the host's own
 * composition entry) registers a factory for each supported `sensorType`, and the runtime creates
 * instances by looking the type up. Unregistered sensors are reported by the host as a warning and
 * skipped, so a document that uses a sensor this build does not implement still loads.
 */

import type { SensorEntity } from '../entities';
import type { Sensor } from './base';

/** Creates the runtime object of one sensor entity. */
export type SensorFactory = (entity: SensorEntity) => Sensor;

/** Mutable registry mapping a `sensorType` onto its factory. */
export class SensorRegistry {
  private readonly factories = new Map<string, SensorFactory>();

  /**
   * Registers the factory of one sensor type.
   *
   * @throws {TypeError} when `type` or `factory` is malformed.
   * @throws {Error} when the type is already registered.
   */
  public register(type: string, factory: SensorFactory): void {
    if (typeof type !== 'string' || type === '') {
      throw new TypeError('SensorRegistry.register: type must be a non-empty string');
    }
    if (typeof factory !== 'function') {
      throw new TypeError(`SensorRegistry.register: factory for "${type}" must be a function`);
    }
    if (this.factories.has(type)) {
      throw new Error(`Sensor type "${type}" already registered`);
    }
    this.factories.set(type, factory);
  }

  /**
   * Removes the factory of one sensor type.
   *
   * @returns `true` when a factory was removed.
   */
  public unregister(type: string): boolean {
    return this.factories.delete(type);
  }

  /** Whether a factory is registered for `type`. */
  public has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * Creates the sensor runtime of an entity.
   *
   * @throws {TypeError} when the entity carries no usable `sensorType`.
   * @throws {Error} when no factory is registered for that type.
   */
  public create(entity: SensorEntity): Sensor {
    if (typeof entity !== 'object' || entity === null) {
      throw new TypeError('SensorRegistry.create: an entity is required');
    }
    const type: unknown = entity.sensorType;
    if (typeof type !== 'string' || type === '') {
      throw new TypeError(`SensorRegistry.create: sensor "${String(entity.id)}" has no sensorType`);
    }

    const factory = this.factories.get(type);
    if (factory === undefined) {
      throw new Error(`Sensor type "${type}" not registered`);
    }
    return factory(entity);
  }

  /** Registered sensor types, in registration order. */
  public types(): readonly string[] {
    return Array.from(this.factories.keys());
  }

  /** Removes every registration; useful for tests and for replacing a build's sensor set. */
  public clear(): void {
    this.factories.clear();
  }
}

/**
 * Process-wide registry used by {@link Scene3DHost}.
 *
 * A global keeps the document format independent of the implementation package: an application
 * registers the sensor kinds it ships before creating a host.
 */
export const sensorRegistry = new SensorRegistry();
