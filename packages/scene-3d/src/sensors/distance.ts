import type { DistanceConfig, SensorEntity } from '../entities';
import { Quaternion, Vec3d } from '../math';
import type { PhysicsRuntime, RaycastHit } from '../physics';
import { Sensor } from './base';
import type { DistanceSensorData } from './types';

const FORWARD = { x: 0, y: 0, z: -1 } as const;
const SAMPLE_AZIMUTHS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2] as const;

/** Deterministic cone-sampling distance sensor. */
export class DistanceSensor extends Sensor<DistanceSensorData> {
  private readonly config: DistanceConfig;

  public constructor(entity: SensorEntity) {
    super(entity);
    this.config = entity.config as DistanceConfig;
  }

  protected update(physics: PhysicsRuntime, currentTime: bigint): DistanceSensorData {
    const transform = this.getWorldTransform(physics);
    const forward = Quaternion.rotate(transform.rotation, FORWARD);
    const directions = this.config.fov <= 0 ? [forward] : this.coneDirections(transform.rotation);
    let nearest: number | null = null;

    for (const direction of directions) {
      const hit = raycastIgnoringMountedBody(
        physics,
        transform.position,
        direction,
        this.config.maxRange,
        this.mountedOn,
      );
      if (
        hit !== null &&
        Number.isFinite(hit.distance) &&
        hit.distance >= 0 &&
        hit.distance <= this.config.maxRange &&
        (nearest === null || hit.distance < nearest)
      ) {
        nearest = hit.distance;
      }
    }

    return { type: 'distance', distance: nearest, timestamp: currentTime };
  }

  private coneDirections(rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  }): readonly Vec3d[] {
    const halfAngle = (Math.max(0, this.config.fov) * Math.PI) / 360;
    const sin = Math.sin(halfAngle);
    const axial = -Math.cos(halfAngle);
    return [
      Quaternion.rotate(rotation, FORWARD),
      ...SAMPLE_AZIMUTHS.map((azimuth) =>
        Quaternion.rotate(rotation, {
          x: sin * Math.cos(azimuth),
          y: sin * Math.sin(azimuth),
          z: axial,
        }),
      ),
    ];
  }
}

/** Ignores the mounted body; the physics engine may return it before the surface being sensed. */
function raycastIgnoringMountedBody(
  physics: PhysicsRuntime,
  origin: Vec3d,
  direction: Vec3d,
  maxDistance: number,
  mountedOn: string | undefined,
): RaycastHit | null {
  let hit = physics.raycast(origin, direction, maxDistance);
  if (mountedOn !== undefined && hit?.bodyId === mountedOn) {
    // The in-memory runtime returns null when the origin is inside a shape. A second query also
    // lets physics adapters that advance through filtered hits expose the next surface.
    hit = physics.raycast(origin, direction, maxDistance);
  }
  return hit?.bodyId === mountedOn ? null : hit;
}
