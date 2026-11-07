import type { Vec3d } from '../math';
import {
  DEFAULT_GRAVITY,
  JOINT_TARGET_KINDS,
  JOINT_TYPES,
  type JointConfig,
  type JointState,
  type JointTarget,
  type PhysicsRuntime,
  type RaycastHit,
  type RigidBodyConfig,
} from './index';

declare const position: Vec3d;
declare const runtime: PhysicsRuntime;
declare const rayHit: RaycastHit;
declare const jointState: JointState;

const body: RigidBodyConfig = {
  id: 'crate',
  bodyType: 'dynamic',
  position,
  collider: { type: 'sphere', radius: 0.1 },
  mass: 1,
  velocity: position,
  angularVelocity: position,
  constraints: { freezePosition: { x: true }, freezeRotation: { z: false } },
  boundingRadius: 0.5,
};

const joint: JointConfig = {
  type: 'revolute',
  bodyA: 'crate',
  bodyB: 'crate',
  anchorA: position,
  anchorB: position,
  axis: position,
  limits: { min: -Math.PI, max: Math.PI },
  motor: { maxForce: 1, maxVelocity: 2 },
};

const targets: readonly JointTarget[] = [
  { kind: 'position', value: 0 },
  { kind: 'velocity', value: 1 },
  { kind: 'torque', value: -1 },
];

const pose = runtime.getBodyTransform('crate');
const hit: RaycastHit | null = runtime.raycast(position, position, 10);

// @ts-expect-error a rigid body needs a collider
const missingCollider: RigidBodyConfig = { bodyType: 'dynamic' };
const unknownBodyType: RigidBodyConfig = {
  collider: { type: 'sphere', radius: 1 },
  // @ts-expect-error the body type is a closed union
  bodyType: 'floating',
};
// @ts-expect-error a joint needs the body it is attached to
const missingBody: JointConfig = { type: 'revolute' };
// @ts-expect-error joint types are a closed union
const unknownJointType: JointConfig = { type: 'hinge', bodyA: 'crate' };
// @ts-expect-error a position target carries its scalar value
const missingTargetValue: JointTarget = { kind: 'position' };
// @ts-expect-error target kinds are a closed union
const unknownTargetKind: JointTarget = { kind: 'force', value: 1 };
// @ts-expect-error joint limits are scalar bounds
const stringLimit: JointConfig = { type: 'revolute', bodyA: 'crate', limits: { min: '0' } };
const flatPosition: RigidBodyConfig = {
  collider: { type: 'sphere', radius: 1 },
  // @ts-expect-error a rigid body position needs three axes
  position: { x: 0, y: 0 },
};
// @ts-expect-error the runtime pose is immutable
pose.position.x = 1;
// @ts-expect-error raycast hits are immutable
rayHit.normal.x = 1;
// @ts-expect-error joint state is immutable
jointState.position = 1;

void [
  DEFAULT_GRAVITY,
  JOINT_TARGET_KINDS,
  JOINT_TYPES,
  body,
  flatPosition,
  hit,
  joint,
  jointState,
  missingBody,
  missingCollider,
  missingTargetValue,
  pose,
  stringLimit,
  targets,
  unknownBodyType,
  unknownJointType,
  unknownTargetKind,
];
