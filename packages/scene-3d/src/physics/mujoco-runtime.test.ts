import { describe, expect, it } from 'vitest';
import { Quaternion, Vec3d } from '../math';
import { createMujocoRuntime, MujocoRuntime } from './mujoco-runtime';
import { DEFAULT_GRAVITY } from './types';
import type { PhysicsRuntime, RigidBodyConfig } from './types';

const SPHERE: RigidBodyConfig['collider'] = { type: 'sphere', radius: 0.5 };
const BOX: RigidBodyConfig['collider'] = { type: 'box', size: { x: 1, y: 1, z: 1 } };
const MESH: RigidBodyConfig['collider'] = { type: 'trimesh', source: 'geometry' };

async function createRuntime(): Promise<MujocoRuntime> {
  const runtime = createMujocoRuntime();
  await runtime.initialize({ bodyType: 'dynamic' });
  return runtime;
}

describe('MujocoRuntime initialization', () => {
  it('implements the physics runtime contract', () => {
    const runtime: PhysicsRuntime = new MujocoRuntime();

    expect(runtime).toBeInstanceOf(MujocoRuntime);
  });

  it('applies the configured body type to bodies that omit one', async () => {
    const runtime = new MujocoRuntime();
    await runtime.initialize({ bodyType: 'static' });

    const bodyId = runtime.addBody({ position: { x: 0, y: 1, z: 0 }, collider: SPHERE });
    runtime.step(1000);

    expect(runtime.getBodyTransform(bodyId).position.y).toBe(1);
  });

  it('requires initialize before adding bodies', () => {
    const runtime = new MujocoRuntime();

    expect(() => runtime.addBody({ collider: SPHERE })).toThrow(/initialize\(\) must be called/);
  });

  it('resets bodies and generated ids when initialized again', async () => {
    const runtime = await createRuntime();
    const first = runtime.addBody({ collider: SPHERE });

    await runtime.initialize({ bodyType: 'dynamic' });

    expect(() => runtime.getBodyTransform(first)).toThrow(/unknown body/);
    expect(runtime.addBody({ collider: SPHERE })).toBe('body-1');
  });

  it('rejects duplicate explicit ids', async () => {
    const runtime = await createRuntime();
    runtime.addBody({ id: 'crate', collider: SPHERE });

    expect(() => runtime.addBody({ id: 'crate', collider: SPHERE })).toThrow(/already exists/);
  });
});

describe('MujocoRuntime stepping', () => {
  it('applies world-space gravity to dynamic bodies only', async () => {
    const runtime = await createRuntime();
    const dynamicId = runtime.addBody({
      bodyType: 'dynamic',
      position: { x: 0, y: 10, z: 0 },
      collider: SPHERE,
    });
    const staticId = runtime.addBody({
      bodyType: 'static',
      position: { x: 0, y: 10, z: 0 },
      collider: SPHERE,
    });

    runtime.step(1000);

    const dynamic = runtime.getBodyTransform(dynamicId).position;
    expect(dynamic.x).toBe(0);
    expect(dynamic.y).toBeCloseTo(10 + DEFAULT_GRAVITY.y, 6);
    expect(dynamic.z).toBe(0);
    expect(runtime.getBodyTransform(staticId).position).toEqual({ x: 0, y: 10, z: 0 });
  });

  it('integrates velocity with the requested number of milliseconds', async () => {
    const runtime = await createRuntime();
    const dynamicId = runtime.addBody({
      bodyType: 'dynamic',
      position: { x: 0, y: 100, z: 0 },
      velocity: { x: 2, y: 0, z: 0 },
      collider: SPHERE,
    });
    const kinematicId = runtime.addBody({
      bodyType: 'kinematic',
      position: Vec3d.zero,
      velocity: { x: 0, y: 2, z: 0 },
      collider: SPHERE,
    });

    runtime.step(500);

    expect(runtime.getBodyTransform(dynamicId).position.x).toBeCloseTo(1, 9);
    expect(runtime.getBodyTransform(kinematicId).position.y).toBeCloseTo(1, 9);
  });

  it('honours per-axis translation locks', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({
      bodyType: 'dynamic',
      position: { x: 0, y: 5, z: 0 },
      velocity: { x: 1, y: 0, z: 0 },
      constraints: { freezePosition: { y: true } },
      collider: SPHERE,
    });

    runtime.step(1000);

    const { position } = runtime.getBodyTransform(bodyId);
    expect(position.x).toBeCloseTo(1, 9);
    expect(position.y).toBe(5);
  });

  it('integrates angular velocity around the world axis', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({
      bodyType: 'kinematic',
      angularVelocity: Vec3d.unitY,
      collider: SPHERE,
    });

    runtime.step(1000);

    const expected = Quaternion.fromAxisAngle(Vec3d.unitY, 1);
    expect(Quaternion.equals(runtime.getBodyTransform(bodyId).rotation, expected, 1e-9)).toBe(true);
  });

  it('treats a zero-length step as a no-op and rejects negative steps', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({
      position: { x: 0, y: 10, z: 0 },
      collider: SPHERE,
    });

    runtime.step(0);
    expect(runtime.getBodyTransform(bodyId).position.y).toBe(10);

    expect(() => runtime.step(-1)).toThrow(RangeError);
  });
});

describe('MujocoRuntime joints', () => {
  it('drives a revolute joint toward a position target at motor speed', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({ collider: SPHERE });
    const jointId = runtime.addJoint({
      type: 'revolute',
      bodyA: bodyId,
      motor: { maxForce: 1, maxVelocity: 2 },
    });

    expect(jointId).toBe('joint-1');
    expect(runtime.getJointState(jointId)).toEqual({ position: 0, velocity: 0, torque: 0 });

    runtime.setJointTarget(jointId, { kind: 'position', value: Math.PI });
    runtime.step(250);

    const state = runtime.getJointState(jointId);
    expect(state.position).toBeCloseTo(0.5, 9);
    expect(state.velocity).toBeCloseTo(2, 9);
  });

  it('integrates velocity targets and clamps them to the joint limits', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({ collider: SPHERE });
    const jointId = runtime.addJoint({
      type: 'prismatic',
      bodyA: bodyId,
      limits: { min: 0, max: 0.3 },
      motor: { maxForce: 1, maxVelocity: 1 },
    });

    runtime.setJointTarget(jointId, { kind: 'velocity', value: 1 });
    runtime.step(1000);

    const state = runtime.getJointState(jointId);
    expect(state.position).toBe(0.3);
    expect(state.velocity).toBeCloseTo(0.3, 9);
  });

  it('reports torque targets without moving the joint', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({ collider: SPHERE });
    const jointId = runtime.addJoint({
      type: 'revolute',
      bodyA: bodyId,
      bodyB: bodyId,
    });

    runtime.setJointTarget(jointId, { kind: 'torque', value: 2 });
    runtime.step(1000);

    expect(runtime.getJointState(jointId)).toEqual({ position: 0, velocity: 0, torque: 2 });
  });

  it('keeps non-scalar joints at rest', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({ collider: SPHERE });
    const jointId = runtime.addJoint({ type: 'spherical', bodyA: bodyId });

    runtime.setJointTarget(jointId, { kind: 'position', value: 1 });
    runtime.step(1000);

    expect(runtime.getJointState(jointId)).toEqual({ position: 0, velocity: 0, torque: 0 });
  });

  it('rejects unknown bodies, duplicate ids and degenerate axes', async () => {
    const runtime = await createRuntime();
    const bodyId = runtime.addBody({ collider: SPHERE });

    expect(() => runtime.addJoint({ type: 'revolute', bodyA: 'missing' })).toThrow(/unknown body/);
    expect(() => runtime.addJoint({ type: 'revolute', bodyA: bodyId, axis: Vec3d.zero })).toThrow(
      /non-zero axis/,
    );

    runtime.addJoint({ id: 'wheel', type: 'revolute', bodyA: bodyId });
    expect(() => runtime.addJoint({ id: 'wheel', type: 'fixed', bodyA: bodyId })).toThrow(
      /already exists/,
    );
    expect(() => runtime.getJointState('missing')).toThrow(/unknown joint/);
  });
});

describe('MujocoRuntime raycast', () => {
  it('returns the nearest bounding-sphere hit', async () => {
    const runtime = await createRuntime();
    runtime.addBody({
      position: { x: 0, y: 0, z: 5 },
      collider: { type: 'sphere', radius: 1 },
    });
    const nearId = runtime.addBody({
      position: { x: 0, y: 0, z: 2 },
      collider: { type: 'sphere', radius: 0.5 },
    });

    const hit = runtime.raycast(Vec3d.zero, Vec3d.unitZ, 10);

    expect(hit).not.toBeNull();
    expect(hit?.bodyId).toBe(nearId);
    expect(hit?.distance).toBeCloseTo(1.5, 9);
    expect(hit?.point).toEqual({ x: 0, y: 0, z: 1.5 });
    expect(hit?.normal).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('respects maxDistance and ignores a zero-length direction', async () => {
    const runtime = await createRuntime();
    runtime.addBody({ position: { x: 0, y: 0, z: 5 }, collider: SPHERE });

    expect(runtime.raycast(Vec3d.zero, Vec3d.unitZ, 4)).toBeNull();
    expect(runtime.raycast(Vec3d.zero, Vec3d.zero, 10)).toBeNull();
    expect(() => runtime.raycast(Vec3d.zero, Vec3d.unitZ, -1)).toThrow(RangeError);
  });

  it('derives bounding radii for boxes and compound colliders', async () => {
    const runtime = await createRuntime();
    const boxId = runtime.addBody({ position: { x: 0, y: 0, z: 2 }, collider: BOX });
    const compoundId = runtime.addBody({
      position: { x: 5, y: 0, z: 0 },
      collider: {
        type: 'compound',
        children: [
          { type: 'sphere', radius: 0.25 },
          { type: 'box', size: { x: 1, y: 1, z: 1 } },
        ],
      },
    });

    expect(runtime.raycast(Vec3d.zero, Vec3d.unitZ, 10)?.bodyId).toBe(boxId);
    expect(runtime.raycast(Vec3d.zero, Vec3d.unitX, 10)?.bodyId).toBe(compoundId);
  });

  it('skips mesh colliders unless a bounding radius is supplied', async () => {
    const runtime = await createRuntime();
    runtime.addBody({ position: { x: 0, y: 0, z: 5 }, collider: MESH });

    expect(runtime.raycast(Vec3d.zero, Vec3d.unitZ, 10)).toBeNull();

    const meshId = runtime.addBody({
      position: { x: 0, y: 0, z: 5 },
      collider: MESH,
      boundingRadius: 1,
    });
    expect(runtime.raycast(Vec3d.zero, Vec3d.unitZ, 10)?.bodyId).toBe(meshId);
  });
});

describe('MujocoRuntime dispose', () => {
  it('refuses every operation after dispose and tolerates repeated calls', async () => {
    const runtime = await createRuntime();
    runtime.addBody({ collider: SPHERE });

    runtime.dispose();
    runtime.dispose();

    expect(() => runtime.step(16)).toThrow(/disposed/);
    expect(() => runtime.addBody({ collider: SPHERE })).toThrow(/disposed/);
    expect(() => runtime.raycast(Vec3d.zero, Vec3d.unitZ, 1)).toThrow(/disposed/);
    await expect(runtime.initialize({ bodyType: 'dynamic' })).rejects.toThrow(/disposed/);
  });
});
