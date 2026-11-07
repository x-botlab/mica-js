/**
 * Sensor runtime base class (#192).
 *
 * A sensor wraps one {@link SensorEntity} and turns it into a callable runtime object. Concrete
 * sensor kinds (distance, IMU, camera, …) implement {@link Sensor.update}; this class owns the two
 * pieces every sensor shares:
 *
 * - **frequency control** — {@link Sensor.tryUpdate} returns `null` until the virtual clock has
 *   advanced by the interval implied by the configured `updateRate`, so the host can call every
 *   sensor on every frame and only the ones that are due do work;
 * - **mounting** — {@link Sensor.getWorldTransform} combines the pose of the entity the sensor is
 *   mounted on with the sensor's local offset.
 *
 * The clock is the same picosecond (`TimePs`) clock the circuit simulators use, which keeps sensor
 * sampling deterministic and independent of wall time.
 */

import type { SensorConfig, SensorEntity } from '../entities';
import { Quaternion, Vec3d, type Transform } from '../math';
import type { PhysicsRuntime } from '../physics/types';
import { PS_PER_SECOND, type SensorData } from './types';

/** Sampling frequency used when a configuration omits `updateRate`. */
export const DEFAULT_SENSOR_UPDATE_RATE = 30;

/**
 * Base class of every sensor runtime.
 *
 * `TData` is the concrete reading the subclass produces; the default covers sensors that need no
 * narrowing. A sensor is created from its entity only — engines and renderers arrive per update,
 * so the same instance can be reused when the host swaps implementations.
 */
export abstract class Sensor<TData extends SensorData = SensorData> {
  /** Sensor identity, matching {@link SensorEntity.id}. */
  public readonly id: string;

  /** Entity the sensor was created from. */
  protected readonly entity: SensorEntity;

  /** Configured sampling frequency in hertz. */
  protected readonly updateRate: number;

  /** Entity the sensor is mounted on, or `undefined` for a world-fixed sensor. */
  protected readonly mountedOn: string | undefined;

  /** Virtual time of the last completed reading, in picoseconds. */
  private lastUpdateTime: bigint | null = null;

  /** Minimum virtual interval between two readings, in picoseconds. */
  private readonly intervalPs: bigint;

  public constructor(entity: SensorEntity) {
    if (typeof entity !== 'object' || entity === null) {
      throw new TypeError('Sensor: an entity is required');
    }
    if (typeof entity.id !== 'string' || entity.id === '') {
      throw new TypeError('Sensor: entity.id must be a non-empty string');
    }

    this.id = entity.id;
    this.entity = entity;
    this.updateRate = extractUpdateRate(entity.config);
    this.intervalPs = toIntervalPs(this.updateRate);
    this.mountedOn = entity.mountedOn;
  }

  /** Virtual time of the last completed reading, or `null` before the first one. */
  public get lastUpdatedAt(): bigint | null {
    return this.lastUpdateTime;
  }

  /**
   * Samples the sensor when its update interval has elapsed.
   *
   * @param physics Physics runtime used to resolve the mount pose and to query the world.
   * @param currentTime Current virtual time in picoseconds.
   * @returns The reading, or `null` when the sensor is not due yet.
   */
  public tryUpdate(physics: PhysicsRuntime, currentTime: bigint): TData | null {
    if (!this.shouldUpdate(currentTime)) {
      return null;
    }

    const data = this.update(physics, currentTime);
    this.lastUpdateTime = currentTime;
    return data;
  }

  /** Produces one reading; only called when the sensor is due. */
  protected abstract update(physics: PhysicsRuntime, currentTime: bigint): TData;

  /**
   * World pose of the sensor.
   *
   * A mounted sensor composes the parent body pose with its local pose: the local offset is
   * rotated into world space and the rotations are multiplied. A world-fixed sensor returns its
   * entity pose unchanged and never touches the physics runtime.
   */
  protected getWorldTransform(physics: PhysicsRuntime): Transform {
    const localPosition = this.entity.position;
    const localRotation = this.entity.rotation;
    if (this.mountedOn === undefined) {
      return { position: localPosition, rotation: localRotation };
    }

    const parent = physics.getBodyTransform(this.mountedOn);
    return {
      position: Vec3d.add(parent.position, Quaternion.rotate(parent.rotation, localPosition)),
      rotation: Quaternion.multiply(parent.rotation, localRotation),
    };
  }

  /** Whether the virtual clock has advanced by at least one sampling interval. */
  private shouldUpdate(currentTime: bigint): boolean {
    if (this.lastUpdateTime === null) {
      return true;
    }
    return currentTime - this.lastUpdateTime >= this.intervalPs;
  }
}

/**
 * Sensor that returns a fixed reading, used by tests and as a placeholder in tooling.
 *
 * The timestamp is always replaced with the virtual time of the reading, so a test can assert the
 * host is passing the right clock without building a concrete sensor.
 */
export class MockSensor extends Sensor {
  private readonly mockData: SensorData;

  public constructor(entity: SensorEntity, mockData: SensorData) {
    super(entity);
    this.mockData = mockData;
  }

  protected update(_physics: PhysicsRuntime, currentTime: bigint): SensorData {
    return { ...this.mockData, timestamp: currentTime } as SensorData;
  }
}

/** Reads `updateRate` from a type-specific configuration, defaulting to 30 Hz. */
function extractUpdateRate(config: SensorConfig | undefined): number {
  if (typeof config !== 'object' || config === null) {
    return DEFAULT_SENSOR_UPDATE_RATE;
  }

  const rate = (config as { readonly updateRate?: unknown }).updateRate;
  if (rate === undefined) {
    return DEFAULT_SENSOR_UPDATE_RATE;
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new TypeError('Sensor: config.updateRate must be a finite number');
  }
  if (rate <= 0) {
    throw new RangeError('Sensor: config.updateRate must be greater than 0');
  }
  return rate;
}

/** Converts hertz into a whole number of picoseconds, never shorter than one tick. */
function toIntervalPs(updateRate: number): bigint {
  const interval = Math.round(Number(PS_PER_SECOND) / updateRate);
  return BigInt(Math.max(1, interval));
}
