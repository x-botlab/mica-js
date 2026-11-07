/**
 * Physics runtime contracts (#180).
 *
 * The scene runtime only ever talks to a physics engine through {@link PhysicsRuntime}. Keeping
 * the contract free of engine types lets the in-memory `MujocoRuntime` stand-in used today be
 * replaced by the real MuJoCo WASM adapter without touching the layers above it.
 *
 * Every value that crosses this interface is plain and readonly, and already expressed in the
 * scene's world frame: right-handed, Y-up, metres, radians and seconds. MuJoCo itself is Z-up, so
 * the adapter — not its callers — owns the coordinate conversion.
 */

import type { BodyType, ColliderDescriptor, MotionConstraints, PhysicsConfig } from '../entities';
import type { Quaternion, Vec3d } from '../math';

/** Joint kinds, mirroring the joint entities of the `.scene3d` document. */
export const JOINT_TYPES = ['revolute', 'prismatic', 'spherical', 'fixed'] as const;

/** Kind of a joint: single-axis rotation, single-axis translation, ball or rigid attachment. */
export type JointType = (typeof JOINT_TYPES)[number];

/** Ways a joint can be driven. */
export const JOINT_TARGET_KINDS = ['position', 'velocity', 'torque'] as const;

/** Kind of a {@link JointTarget}. */
export type JointTargetKind = (typeof JOINT_TARGET_KINDS)[number];

/**
 * Command sent to a joint.
 *
 * `position` (radians for a revolute joint, metres for a prismatic one) and `velocity` are servo
 * targets; `torque` is a raw effort in N·m or N. Spherical and fixed joints have no scalar degree
 * of freedom, so the runtime accepts and stores the target but leaves their state at zero.
 */
export type JointTarget =
  | { readonly kind: 'position'; readonly value: number }
  | { readonly kind: 'velocity'; readonly value: number }
  | { readonly kind: 'torque'; readonly value: number };

/** Travel limits of a scalar joint; an omitted bound is unbounded on that side. */
export interface JointLimits {
  /** Lower bound in radians (revolute) or metres (prismatic). */
  readonly min?: number;
  /** Upper bound in radians (revolute) or metres (prismatic). */
  readonly max?: number;
}

/** Motor limits of a joint, matching the `motor` payload of a joint entity. */
export interface JointMotorConfig {
  /** Maximum effort in N·m (revolute) or N (prismatic). */
  readonly maxForce: number;
  /** Maximum speed in rad/s (revolute) or m/s (prismatic). */
  readonly maxVelocity: number;
}

/** Live state of a scalar joint. */
export interface JointState {
  /** Current position in radians (revolute) or metres (prismatic). */
  readonly position: number;
  /** Current speed in rad/s (revolute) or m/s (prismatic). */
  readonly velocity: number;
  /** Effort applied during the last step, in N·m or N. */
  readonly torque: number;
}

/** Description of a rigid body the runtime should create. */
export interface RigidBodyConfig {
  /** Requested identity; the runtime generates `body-<n>` when omitted. */
  readonly id?: string;
  /** Rigid-body mode; falls back to the body type passed to `initialize`. */
  readonly bodyType?: BodyType;
  /** Initial position in world space; defaults to the origin. */
  readonly position?: Vec3d;
  /** Initial rotation; defaults to the identity quaternion. */
  readonly rotation?: Quaternion;
  /** Collision shape of the body. */
  readonly collider: ColliderDescriptor;
  /** Mass in kilograms; only dynamic bodies use it. */
  readonly mass?: number;
  /** Coulomb friction coefficient of the surface. */
  readonly friction?: number;
  /** Bounciness in the `0..1` range. */
  readonly restitution?: number;
  /** Initial linear velocity in metres per second. */
  readonly velocity?: Vec3d;
  /** Initial angular velocity in radians per second. */
  readonly angularVelocity?: Vec3d;
  /** Per-axis motion locks. */
  readonly constraints?: MotionConstraints;
  /**
   * Bounding radius used by {@link PhysicsRuntime.raycast} when the collider is a trimesh or a
   * convex hull, which carry no measurable extent of their own. Mesh bodies without a radius are
   * invisible to raycasts.
   */
  readonly boundingRadius?: number;
}

/** Description of a joint the runtime should create. */
export interface JointConfig {
  /** Requested identity; the runtime generates `joint-<n>` when omitted. */
  readonly id?: string;
  /** Joint kind. */
  readonly type: JointType;
  /** First body; the joint anchor is expressed in this body's local frame. */
  readonly bodyA: string;
  /** Second body; omitted attaches the joint to the world. */
  readonly bodyB?: string;
  /** Anchor in `bodyA`'s local frame; defaults to that body's origin. */
  readonly anchorA?: Vec3d;
  /** Anchor in `bodyB`'s local frame; defaults to that body's origin. */
  readonly anchorB?: Vec3d;
  /** Rotation or translation axis in `bodyA`'s local frame; defaults to the local Y axis. */
  readonly axis?: Vec3d;
  /** Travel limits. */
  readonly limits?: JointLimits;
  /** Motor limits used by servo targets. */
  readonly motor?: JointMotorConfig;
}

/** Pose of a body after the latest step. */
export interface BodyTransform {
  readonly position: Vec3d;
  readonly rotation: Quaternion;
}

/** Intersection of a ray with a body's collision shape. */
export interface RaycastHit {
  /** Body that was hit. */
  readonly bodyId: string;
  /** Distance from the ray origin along the normalized direction. */
  readonly distance: number;
  /** World-space intersection point. */
  readonly point: Vec3d;
  /** World-space surface normal at the intersection. */
  readonly normal: Vec3d;
}

/**
 * Engine-agnostic physics runtime.
 *
 * The runtime owns the live simulation; the document only carries initial poses. Bodies are
 * referenced by the identity returned from {@link PhysicsRuntime.addBody}, joints by
 * {@link PhysicsRuntime.addJoint}. Once {@link PhysicsRuntime.dispose} is called, the runtime
 * refuses every other operation.
 */
export interface PhysicsRuntime {
  /**
   * Creates the physics world. `config` supplies the defaults applied to bodies added later; the
   * world starts empty, so the scene layer decides which entities become bodies.
   */
  initialize(config: PhysicsConfig): Promise<void>;
  /** Advances the simulation by `deltaMs` milliseconds. */
  step(deltaMs: number): void;
  /** Adds a rigid body and returns its identity. */
  addBody(config: RigidBodyConfig): string;
  /** Adds a joint between two bodies, or between a body and the world, and returns its identity. */
  addJoint(config: JointConfig): string;
  /** Sets the command of a joint; the next {@link PhysicsRuntime.step} applies it. */
  setJointTarget(jointId: string, target: JointTarget): void;
  /**
   * Removes a body and every joint that references it.
   *
   * Optional because the first contract (#180) did not include it and an adapter may not support
   * live removal yet. `MujocoRuntime` implements it; the scene host calls it when an entity is
   * removed and otherwise stops reporting the body.
   */
  removeBody?(bodyId: string): void;
  /** Reads the pose of a body. */
  getBodyTransform(bodyId: string): { position: Vec3d; rotation: Quaternion };
  /** Reads the state of a joint. */
  getJointState(jointId: string): JointState;
  /**
   * Casts a ray through the world and returns the nearest hit, or `null` when nothing is within
   * `maxDistance`. `direction` need not be normalized; a zero-length direction hits nothing.
   */
  raycast(origin: Vec3d, direction: Vec3d, maxDistance: number): RaycastHit | null;
  /** Releases the simulation; the runtime refuses further use afterwards. */
  dispose(): void;
}

/** World-space gravity in m/s², Y-up like the rest of the scene package. */
export const DEFAULT_GRAVITY: Vec3d = Object.freeze({ x: 0, y: -9.81, z: 0 });

/** Speed a joint servo uses when its motor does not define `maxVelocity`. */
export const DEFAULT_JOINT_MAX_VELOCITY = 1;
