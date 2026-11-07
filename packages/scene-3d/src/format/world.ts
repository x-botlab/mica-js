import type { Vec3d } from '../math';

/**
 * Ground plane shared by every entity in the scene.
 *
 * The ground is a convenience for teaching scenes: it removes the need to model a large static
 * board just to give robots something to drive on, and its texture can carry a line-following
 * track image.
 */
export interface GroundConfig {
  /** Whether the world has a ground plane at `y = 0`. */
  readonly enabled: boolean;

  /** Texture asset path, for example a line-following track image. */
  readonly texture?: string;

  /** Coulomb friction coefficient in the range 0–1. */
  readonly friction: number;

  /** Coefficient of restitution (bounciness) in the range 0–1. */
  readonly restitution: number;
}

/**
 * Physical world configuration.
 *
 * The document uses a right-handed coordinate system with X to the right, Y up and Z forward;
 * lengths are metres and gravity is therefore expressed in m/s² along Y.
 */
export interface WorldConfig {
  /** Gravity acceleration in m/s²; the default is `{ x: 0, y: -9.81, z: 0 }`. */
  readonly gravity: Vec3d;

  /** Physics step in milliseconds; `1000 / 60` (≈ 16.67 ms) gives a 60 Hz simulation. */
  readonly physicsStep: number;

  /** Optional ground plane; omitted means the scene has no implicit ground. */
  readonly ground?: GroundConfig;
}
