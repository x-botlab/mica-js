/**
 * In-memory stand-in for the MuJoCo WASM runtime (#180).
 *
 * The real engine is a WASM build loaded asynchronously; until that adapter lands, this class
 * implements {@link PhysicsRuntime} with a small, deterministic integrator so the scene runtime,
 * the editor and the tests can already run against the same contract. It has no dependencies and
 * no hidden state, so two runtimes fed the same commands produce the same poses.
 *
 * Modelled today:
 *
 * - world-space gravity on dynamic bodies (Y-up, matching the renderer; the real adapter rotates
 *   MuJoCo's Z-up frame instead),
 * - semi-implicit Euler integration of linear and angular velocity,
 * - per-axis `freezePosition` / `freezeRotation` locks,
 * - revolute and prismatic joint servos with travel limits and motor speed limits,
 * - raycasts against primitive colliders, with documented bounding approximations for meshes.
 *
 * Not modelled yet — these belong to the real engine or to later issues: contacts, friction,
 * restitution, inertia tensors, constraints between bodies, spherical joint degrees of freedom
 * and exact mesh raycasts. `friction` and `restitution` are accepted and stored so callers do not
 * have to change once collisions arrive.
 */

import { BODY_TYPES } from '../entities';
import type { BodyType, ColliderDescriptor, MotionConstraints, PhysicsConfig } from '../entities';
import { Quaternion, Vec3d } from '../math';
import {
  DEFAULT_GRAVITY,
  DEFAULT_JOINT_MAX_VELOCITY,
  JOINT_TARGET_KINDS,
  JOINT_TYPES,
} from './types';
import type {
  BodyMotion,
  BodyTransform,
  JointConfig,
  JointLimits,
  JointState,
  JointTarget,
  JointType,
  PhysicsRuntime,
  RaycastHit,
  RigidBodyConfig,
} from './types';

/** Mass used for a dynamic body that does not declare one. */
const DEFAULT_BODY_MASS = 1;

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

interface MutableQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface BodyRecord {
  readonly id: string;
  readonly bodyType: BodyType;
  readonly mass: number;
  readonly friction: number;
  readonly restitution: number;
  readonly constraints: MotionConstraints;
  readonly collider: ColliderDescriptor;
  readonly boundingRadius: number | null;
  /** Local-space AABB of a mesh collider, when the document supplied one. */
  readonly bounds: { readonly min: MutableVec3; readonly max: MutableVec3 } | null;
  position: MutableVec3;
  rotation: MutableQuaternion;
  velocity: MutableVec3;
  angularVelocity: MutableVec3;
}

interface JointRecord {
  readonly id: string;
  readonly type: JointType;
  readonly bodyA: string;
  readonly bodyB: string | null;
  readonly axis: Vec3d;
  readonly limits: JointLimits;
  readonly maxVelocity: number;
  position: number;
  velocity: number;
  torque: number;
  target: JointTarget | null;
}

/**
 * Deterministic, dependency-free {@link PhysicsRuntime} implementation.
 *
 * ```ts
 * const physics = new MujocoRuntime();
 * await physics.initialize({ bodyType: 'dynamic' });
 *
 * const ball = physics.addBody({
 *   position: { x: 0, y: 1, z: 0 },
 *   collider: { type: 'sphere', radius: 0.1 },
 * });
 *
 * physics.step(1000 / 60);
 * const { position } = physics.getBodyTransform(ball);
 * ```
 */
export class MujocoRuntime implements PhysicsRuntime {
  private readonly bodies = new Map<string, BodyRecord>();
  private readonly joints = new Map<string, JointRecord>();
  private defaults: PhysicsConfig = { bodyType: 'dynamic' };
  private initialized = false;
  private disposed = false;
  private nextBodyId = 1;
  private nextJointId = 1;

  /**
   * Starts an empty world. Calling it again resets the world and every body and joint created
   * before; a disposed runtime cannot be reinitialized.
   */
  public async initialize(config: PhysicsConfig = { bodyType: 'dynamic' }): Promise<void> {
    this.assertNotDisposed('initialize');
    if (config === null || typeof config !== 'object') {
      throw new TypeError('MujocoRuntime.initialize: config is required');
    }

    const bodyType = config.bodyType;
    if (!BODY_TYPES.includes(bodyType)) {
      throw new TypeError(`MujocoRuntime.initialize: unknown body type "${String(bodyType)}"`);
    }
    if (config.mass !== undefined) {
      assertPositive('initialize.mass', config.mass);
    }
    if (config.velocity !== undefined) {
      assertVec3d('initialize.velocity', config.velocity);
    }
    if (config.angularVelocity !== undefined) {
      assertVec3d('initialize.angularVelocity', config.angularVelocity);
    }

    this.bodies.clear();
    this.joints.clear();
    this.defaults = config;
    this.nextBodyId = 1;
    this.nextJointId = 1;
    this.initialized = true;
  }

  /** Advances every body and joint by `deltaMs` milliseconds. */
  public step(deltaMs: number): void {
    this.assertReady('step');
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('MujocoRuntime.step: deltaMs must be a finite number >= 0');
    }

    const seconds = deltaMs / 1000;
    for (const body of this.bodies.values()) {
      this.stepBody(body, seconds);
    }
    for (const joint of this.joints.values()) {
      this.stepJoint(joint, seconds);
    }
  }

  /** Adds a rigid body; returns the requested id or a generated `body-<n>`. */
  public addBody(config: RigidBodyConfig): string {
    this.assertReady('addBody');
    if (config === null || typeof config !== 'object') {
      throw new TypeError('MujocoRuntime.addBody: config is required');
    }
    if (config.collider === undefined || config.collider === null) {
      throw new TypeError('MujocoRuntime.addBody: collider is required');
    }
    assertCollider(config.collider);

    const bodyType = config.bodyType ?? this.defaults.bodyType;
    if (!BODY_TYPES.includes(bodyType)) {
      throw new TypeError(`MujocoRuntime.addBody: unknown body type "${String(bodyType)}"`);
    }

    const position = config.position ?? Vec3d.zero;
    const rotation = config.rotation ?? Quaternion.identity;
    const velocity = config.velocity ?? this.defaults.velocity ?? Vec3d.zero;
    const angularVelocity = config.angularVelocity ?? this.defaults.angularVelocity ?? Vec3d.zero;
    const mass = config.mass ?? this.defaults.mass ?? DEFAULT_BODY_MASS;
    const friction = config.friction ?? 0.6;
    const restitution = config.restitution ?? 0;

    assertVec3d('addBody.position', position);
    assertQuaternion('addBody.rotation', rotation);
    assertVec3d('addBody.velocity', velocity);
    assertVec3d('addBody.angularVelocity', angularVelocity);
    assertPositive('addBody.mass', mass);
    assertNonNegative('addBody.friction', friction);
    assertNonNegative('addBody.restitution', restitution);
    if (config.boundingRadius !== undefined) {
      assertPositive('addBody.boundingRadius', config.boundingRadius);
    }

    const boundingRadius =
      config.boundingRadius === undefined
        ? colliderBoundingRadius(config.collider)
        : config.boundingRadius;
    const id = this.allocateBodyId(config.id);

    this.bodies.set(id, {
      id,
      bodyType,
      mass,
      friction,
      restitution,
      constraints: config.constraints ?? this.defaults.constraints ?? {},
      collider: config.collider,
      boundingRadius,
      bounds:
        config.bounds === undefined
          ? null
          : {
              min: toMutableVec3(config.bounds.min),
              max: toMutableVec3(config.bounds.max),
            },
      position: toMutableVec3(position),
      rotation: normalizeQuaternion(rotation),
      velocity: toMutableVec3(velocity),
      angularVelocity: toMutableVec3(angularVelocity),
    });

    return id;
  }

  /** Adds a joint; returns the requested id or a generated `joint-<n>`. */
  public addJoint(config: JointConfig): string {
    this.assertReady('addJoint');
    if (config === null || typeof config !== 'object') {
      throw new TypeError('MujocoRuntime.addJoint: config is required');
    }
    if (!JOINT_TYPES.includes(config.type)) {
      throw new TypeError(`MujocoRuntime.addJoint: unknown joint type "${String(config.type)}"`);
    }
    if (!this.bodies.has(config.bodyA)) {
      throw new Error(`MujocoRuntime.addJoint: unknown body "${config.bodyA}"`);
    }
    if (config.bodyB !== undefined && !this.bodies.has(config.bodyB)) {
      throw new Error(`MujocoRuntime.addJoint: unknown body "${config.bodyB}"`);
    }

    const axis = config.axis ?? Vec3d.unitY;
    assertVec3d('addJoint.axis', axis);
    if ((config.type === 'revolute' || config.type === 'prismatic') && Vec3d.length(axis) === 0) {
      throw new RangeError(`MujocoRuntime.addJoint: a ${config.type} joint needs a non-zero axis`);
    }

    const limits = config.limits ?? {};
    if (limits.min !== undefined) {
      assertFinite('addJoint.limits.min', limits.min);
    }
    if (limits.max !== undefined) {
      assertFinite('addJoint.limits.max', limits.max);
    }
    if (limits.min !== undefined && limits.max !== undefined && limits.min > limits.max) {
      throw new RangeError('MujocoRuntime.addJoint: limits.min must not exceed limits.max');
    }

    const maxVelocity = config.motor?.maxVelocity ?? DEFAULT_JOINT_MAX_VELOCITY;
    assertPositive('addJoint.motor.maxVelocity', maxVelocity);
    if (config.motor !== undefined) {
      assertPositive('addJoint.motor.maxForce', config.motor.maxForce);
    }

    const id = this.allocateJointId(config.id);
    this.joints.set(id, {
      id,
      type: config.type,
      bodyA: config.bodyA,
      bodyB: config.bodyB ?? null,
      axis: Vec3d.normalize(axis),
      limits: { ...limits },
      maxVelocity,
      position: 0,
      velocity: 0,
      torque: 0,
      target: null,
    });

    return id;
  }

  /** Stores a joint command; the next {@link step} applies it. */
  public setJointTarget(jointId: string, target: JointTarget): void {
    this.assertReady('setJointTarget');
    const joint = this.jointOrThrow(jointId);

    if (!JOINT_TARGET_KINDS.includes(target.kind)) {
      throw new TypeError(
        `MujocoRuntime.setJointTarget: unknown target kind "${String(target.kind)}"`,
      );
    }
    assertFinite('setJointTarget.value', target.value);

    joint.target = { kind: target.kind, value: target.value };
  }

  /** Returns a copy of the latest body pose. */
  public getBodyTransform(bodyId: string): BodyTransform {
    this.assertReady('getBodyTransform');
    const body = this.bodyOrThrow(bodyId);
    return {
      position: toVec3(body.position),
      rotation: toQuaternion(body.rotation),
    };
  }

  /** Returns a copy of the latest world-space body velocities. */
  public getBodyMotion(bodyId: string): BodyMotion {
    this.assertReady('getBodyMotion');
    const body = this.bodyOrThrow(bodyId);
    return {
      linearVelocity: toVec3(body.velocity),
      angularVelocity: toVec3(body.angularVelocity),
    };
  }

  /** Overrides the world-space velocity of a body; static bodies reject the change. */
  public setBodyVelocity(bodyId: string, motion: BodyMotion): void {
    this.assertReady('setBodyVelocity');
    const body = this.bodyOrThrow(bodyId);
    if (body.bodyType !== 'dynamic') {
      throw new TypeError(`MujocoRuntime.setBodyVelocity: body "${bodyId}" is not dynamic`);
    }
    assertVec3d('setBodyVelocity.linearVelocity', motion.linearVelocity);
    assertVec3d('setBodyVelocity.angularVelocity', motion.angularVelocity);
    body.velocity.x = motion.linearVelocity.x;
    body.velocity.y = motion.linearVelocity.y;
    body.velocity.z = motion.linearVelocity.z;
    body.angularVelocity.x = motion.angularVelocity.x;
    body.angularVelocity.y = motion.angularVelocity.y;
    body.angularVelocity.z = motion.angularVelocity.z;
  }

  /** Returns a copy of the latest joint state. */
  public getJointState(jointId: string): JointState {
    this.assertReady('getJointState');
    const joint = this.jointOrThrow(jointId);
    return {
      position: joint.position,
      velocity: joint.velocity,
      torque: joint.torque,
    };
  }

  /** Removes a body and every joint attached to it; unknown ids are ignored. */
  public removeBody(bodyId: string): void {
    this.assertReady('removeBody');
    this.bodies.delete(bodyId);
    for (const [jointId, joint] of this.joints) {
      if (joint.bodyA === bodyId || joint.bodyB === bodyId) {
        this.joints.delete(jointId);
      }
    }
  }

  /**
   * Casts a ray against every body's collider and returns the nearest hit.
   *
   * Box colliders are intersected in local space, while capsules and cylinders deliberately use
   * their bounding sphere. Meshes, convex hulls and compounds use a pose-aware box whose half-size
   * is `boundingRadius` when one is available; without a radius they have no measurable extent in
   * this in-memory placeholder and are skipped. A ray whose origin is inside a shape returns no
   * hit, rather than the far exit point, so a sensor cannot hit the body it is mounted on.
   */
  public raycast(origin: Vec3d, direction: Vec3d, maxDistance: number): RaycastHit | null {
    this.assertReady('raycast');
    assertVec3d('raycast.origin', origin);
    assertVec3d('raycast.direction', direction);
    if (!Number.isFinite(maxDistance) || maxDistance < 0) {
      throw new RangeError('MujocoRuntime.raycast: maxDistance must be a finite number >= 0');
    }

    const unitDirection = Vec3d.normalize(direction);
    if (Vec3d.length(unitDirection) === 0) {
      return null;
    }

    let nearest: RaycastHit | null = null;
    for (const body of this.bodies.values()) {
      const hit = intersectCollider(origin, unitDirection, maxDistance, body);
      if (hit !== null && (nearest === null || hit.distance < nearest.distance)) {
        nearest = hit;
      }
    }

    return nearest;
  }

  /** Drops every body and joint; further calls on this instance throw. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.bodies.clear();
    this.joints.clear();
    this.initialized = false;
    this.disposed = true;
  }

  private stepBody(body: BodyRecord, seconds: number): void {
    if (body.bodyType === 'static') {
      return;
    }

    const frozenPosition = body.constraints.freezePosition ?? {};
    const frozenRotation = body.constraints.freezeRotation ?? {};

    if (body.bodyType === 'dynamic') {
      if (!frozenPosition.x) {
        body.velocity.x += DEFAULT_GRAVITY.x * seconds;
      }
      if (!frozenPosition.y) {
        body.velocity.y += DEFAULT_GRAVITY.y * seconds;
      }
      if (!frozenPosition.z) {
        body.velocity.z += DEFAULT_GRAVITY.z * seconds;
      }
    }

    if (!frozenPosition.x) {
      body.position.x += body.velocity.x * seconds;
    }
    if (!frozenPosition.y) {
      body.position.y += body.velocity.y * seconds;
    }
    if (!frozenPosition.z) {
      body.position.z += body.velocity.z * seconds;
    }

    if (frozenRotation.x) {
      body.angularVelocity.x = 0;
    }
    if (frozenRotation.y) {
      body.angularVelocity.y = 0;
    }
    if (frozenRotation.z) {
      body.angularVelocity.z = 0;
    }

    const spin = Vec3d.length(body.angularVelocity);
    if (spin > 0 && seconds > 0) {
      const delta = Quaternion.fromAxisAngle(body.angularVelocity, spin * seconds);
      const rotated = Quaternion.multiply(delta, toQuaternion(body.rotation));
      body.rotation = {
        x: rotated.x,
        y: rotated.y,
        z: rotated.z,
        w: rotated.w,
      };
    }
  }

  private stepJoint(joint: JointRecord, seconds: number): void {
    const previousPosition = joint.position;
    let position = joint.position;
    let torque = 0;

    if (joint.type === 'revolute' || joint.type === 'prismatic') {
      const target = joint.target;
      if (target !== null) {
        switch (target.kind) {
          case 'position': {
            const maxDelta = joint.maxVelocity * seconds;
            const delta = clamp(target.value - joint.position, -maxDelta, maxDelta);
            position = joint.position + delta;
            break;
          }
          case 'velocity':
            position = joint.position + target.value * seconds;
            break;
          case 'torque':
            torque = target.value;
            break;
        }
      }
      position = clampToLimits(position, joint.limits);
    }

    joint.position = position;
    joint.velocity = seconds === 0 ? 0 : (position - previousPosition) / seconds;
    joint.torque = torque;
  }

  private allocateBodyId(requested: string | undefined): string {
    if (requested !== undefined) {
      if (requested.length === 0) {
        throw new TypeError('MujocoRuntime.addBody: id must not be empty');
      }
      if (this.bodies.has(requested)) {
        throw new Error(`MujocoRuntime.addBody: body "${requested}" already exists`);
      }
      return requested;
    }

    let id = `body-${this.nextBodyId}`;
    while (this.bodies.has(id)) {
      this.nextBodyId += 1;
      id = `body-${this.nextBodyId}`;
    }
    this.nextBodyId += 1;
    return id;
  }

  private allocateJointId(requested: string | undefined): string {
    if (requested !== undefined) {
      if (requested.length === 0) {
        throw new TypeError('MujocoRuntime.addJoint: id must not be empty');
      }
      if (this.joints.has(requested)) {
        throw new Error(`MujocoRuntime.addJoint: joint "${requested}" already exists`);
      }
      return requested;
    }

    let id = `joint-${this.nextJointId}`;
    while (this.joints.has(id)) {
      this.nextJointId += 1;
      id = `joint-${this.nextJointId}`;
    }
    this.nextJointId += 1;
    return id;
  }

  private bodyOrThrow(bodyId: string): BodyRecord {
    const body = this.bodies.get(bodyId);
    if (body === undefined) {
      throw new Error(`MujocoRuntime: unknown body "${bodyId}"`);
    }
    return body;
  }

  private jointOrThrow(jointId: string): JointRecord {
    const joint = this.joints.get(jointId);
    if (joint === undefined) {
      throw new Error(`MujocoRuntime: unknown joint "${jointId}"`);
    }
    return joint;
  }

  private assertNotDisposed(method: string): void {
    if (this.disposed) {
      throw new Error(`MujocoRuntime.${method}: runtime has been disposed`);
    }
  }

  private assertReady(method: string): void {
    this.assertNotDisposed(method);
    if (!this.initialized) {
      throw new Error(`MujocoRuntime.${method}: initialize() must be called first`);
    }
  }
}

/** Creates an independent runtime; useful for tests and for one physics world per assembly. */
export function createMujocoRuntime(): MujocoRuntime {
  return new MujocoRuntime();
}

/**
 * Bounding-sphere radius of a collider, or `null` when the collider carries no measurable extent
 * (trimesh and convex hull placeholders generated from an entity's geometry).
 */
function colliderBoundingRadius(collider: ColliderDescriptor): number | null {
  switch (collider.type) {
    case 'box':
      return 0.5 * Math.hypot(collider.size.x, collider.size.y, collider.size.z);
    case 'sphere':
      return collider.radius;
    case 'cylinder':
      return Math.hypot(collider.radius, collider.height / 2);
    case 'capsule':
      // `height` already includes the two hemispherical caps, so half of it is the radius of the
      // sphere that encloses the capsule around the body origin.
      return collider.height / 2;
    case 'compound': {
      let radius: number | null = null;
      for (const child of collider.children) {
        const childRadius = colliderBoundingRadius(child);
        if (childRadius !== null && (radius === null || childRadius > radius)) {
          radius = childRadius;
        }
      }
      return radius;
    }
    case 'trimesh':
    case 'convex-hull':
      return null;
    default:
      return assertNever(collider);
  }
}

function intersectCollider(
  origin: Vec3d,
  direction: Vec3d,
  maxDistance: number,
  body: BodyRecord,
): RaycastHit | null {
  switch (body.collider.type) {
    case 'box':
      return intersectBox(origin, direction, maxDistance, body.id, body.position, body.rotation, {
        x: body.collider.size.x / 2,
        y: body.collider.size.y / 2,
        z: body.collider.size.z / 2,
      });
    case 'sphere':
      return intersectSphere(
        origin,
        direction,
        maxDistance,
        body.id,
        body.position,
        body.collider.radius,
      );
    case 'capsule':
    case 'cylinder':
      // The in-memory runtime intentionally approximates these shapes with their bounding sphere.
      return body.boundingRadius === null
        ? null
        : intersectSphere(
            origin,
            direction,
            maxDistance,
            body.id,
            body.position,
            body.boundingRadius,
          );
    case 'trimesh':
    case 'convex-hull':
    case 'compound':
      // A compound is deliberately reduced to the same AABB approximation. The real extent comes
      // from the document when it supplied one: a laser-cut plate is 3 mm thick, so a single
      // bounding sphere would swallow the whole board and hide its surface from sensors.
      if (body.bounds !== null) {
        const center = {
          x: (body.bounds.min.x + body.bounds.max.x) / 2,
          y: (body.bounds.min.y + body.bounds.max.y) / 2,
          z: (body.bounds.min.z + body.bounds.max.z) / 2,
        };
        return intersectBox(
          origin,
          direction,
          maxDistance,
          body.id,
          body.position,
          body.rotation,
          {
            x: (body.bounds.max.x - body.bounds.min.x) / 2,
            y: (body.bounds.max.y - body.bounds.min.y) / 2,
            z: (body.bounds.max.z - body.bounds.min.z) / 2,
          },
          center,
        );
      }
      if (body.boundingRadius === null) {
        // Mesh and hull descriptors do not carry dimensions by themselves; retain the old
        // no-measurable-extent behaviour until a real geometry-aware engine is connected.
        return null;
      }
      return intersectBox(origin, direction, maxDistance, body.id, body.position, body.rotation, {
        x: body.boundingRadius,
        y: body.boundingRadius,
        z: body.boundingRadius,
      });
    default:
      return assertNever(body.collider);
  }
}

function intersectSphere(
  origin: Vec3d,
  direction: Vec3d,
  maxDistance: number,
  bodyId: string,
  center: Vec3d,
  radius: number,
): RaycastHit | null {
  if (radius <= 0) {
    return null;
  }

  const offset = Vec3d.sub(origin, center);
  const radiusSquared = radius * radius;
  // Treat an origin inside a shape as a miss. This avoids returning the far exit point and lets
  // mounted sensors avoid reporting their own parent body.
  if (Vec3d.dot(offset, offset) < radiusSquared) {
    return null;
  }

  const projection = Vec3d.dot(offset, direction);
  const discriminant = projection * projection - (Vec3d.dot(offset, offset) - radiusSquared);
  if (discriminant < 0) {
    return null;
  }

  const root = Math.sqrt(discriminant);
  const distance = -projection - root;
  if (distance < 0 || distance > maxDistance) {
    return null;
  }

  const point = Vec3d.add(origin, Vec3d.scale(direction, distance));
  return {
    bodyId,
    distance,
    point,
    normal: Vec3d.normalize(Vec3d.sub(point, center)),
  };
}

function intersectBox(
  origin: Vec3d,
  direction: Vec3d,
  maxDistance: number,
  bodyId: string,
  center: Vec3d,
  rotation: Quaternion,
  halfExtents: Vec3d,
  localCenter: Vec3d = Vec3d.zero,
): RaycastHit | null {
  const inverseRotation = Quaternion.conjugate(rotation);
  const localOrigin = Quaternion.rotate(
    inverseRotation,
    Vec3d.sub(Vec3d.sub(origin, center), localCenter),
  );
  const localDirection = Quaternion.rotate(inverseRotation, direction);

  // As with spheres, an origin strictly inside the box is a miss rather than an exit hit.
  if (
    Math.abs(localOrigin.x) < halfExtents.x &&
    Math.abs(localOrigin.y) < halfExtents.y &&
    Math.abs(localOrigin.z) < halfExtents.z
  ) {
    return null;
  }

  let near = Number.NEGATIVE_INFINITY;
  let far = maxDistance;
  let nearNormal: Vec3d = Vec3d.zero;
  const axes = [
    {
      origin: localOrigin.x,
      direction: localDirection.x,
      extent: halfExtents.x,
      axis: 'x' as const,
    },
    {
      origin: localOrigin.y,
      direction: localDirection.y,
      extent: halfExtents.y,
      axis: 'y' as const,
    },
    {
      origin: localOrigin.z,
      direction: localDirection.z,
      extent: halfExtents.z,
      axis: 'z' as const,
    },
  ];

  for (const axis of axes) {
    if (Math.abs(axis.direction) < Number.EPSILON) {
      if (axis.origin < -axis.extent || axis.origin > axis.extent) {
        return null;
      }
      continue;
    }

    const first = (-axis.extent - axis.origin) / axis.direction;
    const second = (axis.extent - axis.origin) / axis.direction;
    const entry = Math.min(first, second);
    const exit = Math.max(first, second);
    if (entry > near) {
      near = entry;
      nearNormal = boxFaceNormal(axis.axis, first < second ? -1 : 1);
    }
    far = Math.min(far, exit);
    if (near > far) {
      return null;
    }
  }

  // A negative entry is an exit-only intersection (the ray starts on the boundary and points
  // away), not a forward-facing surface hit.
  if (near < 0 || near > maxDistance || near > far) {
    return null;
  }

  const point = Vec3d.add(origin, Vec3d.scale(direction, near));
  return {
    bodyId,
    distance: near,
    point,
    normal: Quaternion.rotate(rotation, nearNormal),
  };
}

function boxFaceNormal(axis: 'x' | 'y' | 'z', sign: number): Vec3d {
  if (axis === 'x') return { x: sign, y: 0, z: 0 };
  if (axis === 'y') return { x: 0, y: sign, z: 0 };
  return { x: 0, y: 0, z: sign };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampToLimits(value: number, limits: JointLimits): number {
  let clamped = value;
  if (limits.min !== undefined) {
    clamped = Math.max(clamped, limits.min);
  }
  if (limits.max !== undefined) {
    clamped = Math.min(clamped, limits.max);
  }
  return clamped;
}

function toMutableVec3(value: Vec3d): MutableVec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function toVec3(value: MutableVec3): Vec3d {
  return { x: value.x, y: value.y, z: value.z };
}

function toQuaternion(value: MutableQuaternion): Quaternion {
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

function normalizeQuaternion(value: Quaternion): MutableQuaternion {
  const normalized = Quaternion.normalize(value);
  return { x: normalized.x, y: normalized.y, z: normalized.z, w: normalized.w };
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`MujocoRuntime: ${name} must be a finite number`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw new RangeError(`MujocoRuntime: ${name} must be greater than 0`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) {
    throw new RangeError(`MujocoRuntime: ${name} must be greater than or equal to 0`);
  }
}

function assertVec3d(name: string, value: Vec3d): void {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`MujocoRuntime: ${name} must be a Vec3d`);
  }
  assertFinite(`${name}.x`, value.x);
  assertFinite(`${name}.y`, value.y);
  assertFinite(`${name}.z`, value.z);
}

function assertQuaternion(name: string, value: Quaternion): void {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`MujocoRuntime: ${name} must be a Quaternion`);
  }
  assertFinite(`${name}.x`, value.x);
  assertFinite(`${name}.y`, value.y);
  assertFinite(`${name}.z`, value.z);
  assertFinite(`${name}.w`, value.w);
}

function assertCollider(collider: ColliderDescriptor): void {
  switch (collider.type) {
    case 'box':
      assertPositive('collider.size.x', collider.size.x);
      assertPositive('collider.size.y', collider.size.y);
      assertPositive('collider.size.z', collider.size.z);
      return;
    case 'sphere':
      assertPositive('collider.radius', collider.radius);
      return;
    case 'cylinder':
      assertPositive('collider.radius', collider.radius);
      assertPositive('collider.height', collider.height);
      return;
    case 'capsule':
      assertPositive('collider.radius', collider.radius);
      assertPositive('collider.height', collider.height);
      if (collider.height < collider.radius * 2) {
        throw new RangeError(
          'MujocoRuntime: collider.height must be at least 2 * radius for a capsule',
        );
      }
      return;
    case 'compound':
      for (const child of collider.children) {
        assertCollider(child);
      }
      return;
    case 'trimesh':
    case 'convex-hull':
      return;
    default:
      assertNever(collider);
  }
}

function assertNever(value: never): never {
  throw new Error(`MujocoRuntime: unhandled variant ${JSON.stringify(value)}`);
}
