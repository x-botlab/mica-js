import type { GPSConfig, SensorEntity } from '../entities';
import { Vec3d } from '../math';
import { Sensor } from './base';
import type { GPSSensorData } from './types';
import type { PhysicsRuntime } from '../physics';

const METRES_PER_DEGREE_LATITUDE = 111_320;

/** Deterministic local-frame GPS approximation using a WGS84-sized degree scale. */
export class GPSSensor extends Sensor<GPSSensorData> {
  private readonly config: GPSConfig;
  private readonly origin: Vec3d;
  private randomState: number;

  public constructor(entity: SensorEntity) {
    super(entity);
    this.config = entity.config as GPSConfig;
    this.origin = this.config.origin ?? Vec3d.zero;
    this.randomState = seedFromId(entity.id);
  }

  protected update(physics: PhysicsRuntime, currentTime: bigint): GPSSensorData {
    const position = this.getWorldTransform(physics).position;
    const accuracy = Math.max(0, this.config.accuracy);
    const noise = this.noiseVector(accuracy);
    const noisy = {
      x: position.x - this.origin.x + noise.x,
      y: position.y - this.origin.y + noise.y,
      z: position.z - this.origin.z + noise.z,
    };
    const latitude = noisy.z / METRES_PER_DEGREE_LATITUDE;
    const longitude = noisy.x / (METRES_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180));

    return {
      type: 'gps',
      latitude,
      longitude,
      altitude: noisy.y,
      accuracy: this.config.accuracy,
      timestamp: currentTime,
    };
  }

  private noiseVector(amplitude: number): Vec3d {
    const random = this.nextRandom();
    if (amplitude === 0) return Vec3d.zero;
    return {
      x: (random * 2 - 1) * amplitude,
      y: (((random * 1.61803398875) % 1) * 2 - 1) * amplitude,
      z: (((random * 2.41421356237) % 1) * 2 - 1) * amplitude,
    };
  }

  private nextRandom(): number {
    this.randomState = (Math.imul(this.randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return this.randomState / 0x1_0000_0000;
  }
}

function seedFromId(id: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0 || 0x6d2b79f5;
}
