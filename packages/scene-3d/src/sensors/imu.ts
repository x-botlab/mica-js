import type { IMUConfig, SensorEntity } from '../entities';
import { Quaternion, Vec3d } from '../math';
import { DEFAULT_GRAVITY } from '../physics';
import type { PhysicsRuntime } from '../physics';
import { PS_PER_SECOND, type IMUSensorData } from './types';
import { Sensor } from './base';

export interface IMUSensorOptions {
  readonly gravity?: Vec3d;
}

/** Inertial sensor backed by optional physics body motion. */
export class IMUSensor extends Sensor<IMUSensorData> {
  private readonly config: IMUConfig;
  private readonly gravity: Vec3d;
  private previousVelocity: Vec3d | null = null;
  private previousTime: bigint | null = null;

  public constructor(entity: SensorEntity, options: IMUSensorOptions = {}) {
    super(entity);
    this.config = entity.config as IMUConfig;
    this.gravity = options.gravity ?? DEFAULT_GRAVITY;
  }

  protected update(physics: PhysicsRuntime, currentTime: bigint): IMUSensorData {
    const transform = this.getWorldTransform(physics);
    const rotation = Quaternion.normalize(transform.rotation);
    // A real IMU reports in its own axes, so both vectors are rotated out of world space. Consumers
    // that want world values can rotate them back with `orientation`.
    const toLocal = Quaternion.conjugate(rotation);
    const motion = this.readMotion(physics);
    const worldAcceleration = this.readAcceleration(motion?.linearVelocity, currentTime);

    return {
      type: 'imu',
      angularVelocity: toTuple(
        Quaternion.rotate(toLocal, motion === null ? Vec3d.zero : motion.angularVelocity),
      ),
      linearAcceleration: toTuple(Quaternion.rotate(toLocal, worldAcceleration)),
      orientation: [rotation.x, rotation.y, rotation.z, rotation.w],
      timestamp: currentTime,
    };
  }

  private readMotion(physics: PhysicsRuntime) {
    if (this.mountedOn === undefined || physics.getBodyMotion === undefined) return null;
    return physics.getBodyMotion(this.mountedOn);
  }

  private readAcceleration(velocity: Vec3d | undefined, currentTime: bigint): Vec3d {
    if (velocity === undefined) return Vec3d.zero;
    const previousVelocity = this.previousVelocity;
    const previousTime = this.previousTime;
    this.previousVelocity = velocity;
    this.previousTime = currentTime;
    if (previousVelocity === null || previousTime === null) return Vec3d.zero;

    const seconds = Number(currentTime - previousTime) / Number(PS_PER_SECOND);
    if (!(seconds > 0) || !Number.isFinite(seconds)) return Vec3d.zero;
    const acceleration = Vec3d.scale(Vec3d.sub(velocity, previousVelocity), 1 / seconds);
    return Vec3d.sub(acceleration, this.gravity);
  }
}

function toTuple(vector: Vec3d): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}
