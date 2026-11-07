import { describe, expect, it } from 'vitest';
import { createMujocoRuntime, DEFAULT_GRAVITY } from '../physics';
import type { MujocoRuntime, RigidBodyConfig } from '../physics';
import { Scene3DRuntime } from './scene-runtime';
import type { RuntimeOptions } from './types';

const SPHERE: RigidBodyConfig['collider'] = { type: 'sphere', radius: 0.5 };

async function createRuntime(
  options: Omit<RuntimeOptions, 'physics'> = {},
): Promise<{ physics: MujocoRuntime; runtime: Scene3DRuntime }> {
  const physics = createMujocoRuntime();
  await physics.initialize({ bodyType: 'dynamic' });
  return { physics, runtime: new Scene3DRuntime({ physics, ...options }) };
}

describe('Scene3DRuntime clock', () => {
  it('starts at zero and exposes the same time through both accessors', async () => {
    const { runtime } = await createRuntime();

    expect(runtime.currentTime).toBe(0);
    expect(runtime.getCurrentTime()).toBe(0);
  });

  it('honours a configured start time', async () => {
    const { runtime } = await createRuntime({ startTime: 250 });

    expect(runtime.currentTime).toBe(250);
    expect(runtime.getCurrentTime()).toBe(250);
  });

  it('advances the clock by the delta of a single step', async () => {
    const { runtime } = await createRuntime();

    await runtime.step(16);

    expect(runtime.currentTime).toBe(16);
    expect(runtime.getCurrentTime()).toBe(16);
  });

  it('accumulates the delta of every step', async () => {
    const { runtime } = await createRuntime();

    await runtime.step(16);
    await runtime.step(16);
    await runtime.step(16);

    expect(runtime.currentTime).toBe(48);
  });

  it('accumulates uneven deltas without drifting', async () => {
    const { runtime } = await createRuntime({ startTime: 10 });

    await runtime.step(5);
    await runtime.step(10);
    await runtime.step(15);

    expect(runtime.currentTime).toBe(40);
  });

  it('does not move the clock for a zero-length step', async () => {
    const { runtime } = await createRuntime({ startTime: 7 });

    await runtime.step(0);

    expect(runtime.currentTime).toBe(7);
  });

  it('rejects invalid deltas and leaves the clock untouched', async () => {
    const { runtime } = await createRuntime();

    await expect(runtime.step(-1)).rejects.toThrow(RangeError);
    await expect(runtime.step(Number.NaN)).rejects.toThrow(/finite/);
    await expect(runtime.step(Number.POSITIVE_INFINITY)).rejects.toThrow(/finite/);

    expect(runtime.currentTime).toBe(0);
  });

  it('rejects an invalid start time', async () => {
    const physics = createMujocoRuntime();

    expect(() => new Scene3DRuntime({ physics, startTime: -1 })).toThrow(RangeError);
    expect(() => new Scene3DRuntime({ physics, startTime: Number.NaN })).toThrow(RangeError);
  });
});

describe('Scene3DRuntime physics stepping', () => {
  it('lets a dynamic body fall under gravity by the step delta', async () => {
    const { physics, runtime } = await createRuntime();
    const bodyId = physics.addBody({
      position: { x: 0, y: 10, z: 0 },
      collider: SPHERE,
    });

    await runtime.step(1000);

    const { position } = physics.getBodyTransform(bodyId);
    expect(position.x).toBe(0);
    expect(position.y).toBeCloseTo(10 + DEFAULT_GRAVITY.y, 6);
    expect(position.z).toBe(0);
    expect(runtime.currentTime).toBe(1000);
  });

  it('keeps falling across steps, using the same delta as the clock', async () => {
    const { physics, runtime } = await createRuntime();
    const bodyId = physics.addBody({
      position: { x: 0, y: 10, z: 0 },
      collider: SPHERE,
    });

    await runtime.step(500);
    await runtime.step(500);

    const { position } = physics.getBodyTransform(bodyId);
    // Semi-implicit Euler runs once per step, so two 500 ms steps fall less than one 1000 ms
    // step; the exact value proves each step used the delta handed to the clock.
    expect(position.y).toBeCloseTo(10 + 0.75 * DEFAULT_GRAVITY.y, 6);
    expect(runtime.currentTime).toBe(1000);
  });

  it('does not advance physics when the delta is rejected', async () => {
    const { physics, runtime } = await createRuntime();
    const bodyId = physics.addBody({
      position: { x: 0, y: 10, z: 0 },
      collider: SPHERE,
    });

    await expect(runtime.step(-16)).rejects.toThrow(RangeError);

    expect(physics.getBodyTransform(bodyId).position.y).toBe(10);
    expect(runtime.currentTime).toBe(0);
  });

  it('keeps the clock at the last synced time when physics throws', async () => {
    const physics = createMujocoRuntime();
    const runtime = new Scene3DRuntime({ physics });

    await expect(runtime.step(16)).rejects.toThrow(/initialize\(\) must be called/);

    expect(runtime.currentTime).toBe(0);
  });
});

interface DeterministicScene {
  readonly physics: MujocoRuntime;
  readonly runtime: Scene3DRuntime;
  readonly bodyId: string;
  readonly jointId: string;
}

/** Builds a scene whose body and joint both move, so divergence would be visible. */
async function createDeterministicScene(): Promise<DeterministicScene> {
  const { physics, runtime } = await createRuntime();
  const bodyId = physics.addBody({
    position: { x: 0, y: 2, z: 0 },
    velocity: { x: 0.5, y: 0, z: 0 },
    collider: SPHERE,
  });
  const jointId = physics.addJoint({
    type: 'revolute',
    bodyA: bodyId,
    motor: { maxForce: 2, maxVelocity: 3 },
  });
  physics.setJointTarget(jointId, { kind: 'velocity', value: 1.5 });

  return { physics, runtime, bodyId, jointId };
}

describe('Scene3DRuntime determinism', () => {
  it('produces identical state for the same initial state and step sequence', async () => {
    const first = await createDeterministicScene();
    const second = await createDeterministicScene();
    const deltas = [16, 16, 17, 50];

    for (const delta of deltas) {
      await first.runtime.step(delta);
      await second.runtime.step(delta);
    }

    expect(second.runtime.currentTime).toBe(first.runtime.currentTime);
    expect(second.runtime.currentTime).toBe(99);
    expect(second.physics.getBodyTransform(second.bodyId)).toEqual(
      first.physics.getBodyTransform(first.bodyId),
    );
    expect(second.physics.getJointState(second.jointId)).toEqual(
      first.physics.getJointState(first.jointId),
    );

    // Guard against a trivially identical scene: both body and joint must have moved.
    expect(first.physics.getBodyTransform(first.bodyId).position.x).toBeGreaterThan(0);
    expect(first.physics.getBodyTransform(first.bodyId).position.y).toBeLessThan(2);
    expect(first.physics.getJointState(first.jointId).position).toBeGreaterThan(0);
  });

  it('keeps two runtimes independent when their steps are interleaved', async () => {
    const first = await createDeterministicScene();
    const second = await createDeterministicScene();

    await first.runtime.step(100);
    await second.runtime.step(100);
    await first.runtime.step(100);

    expect(first.runtime.currentTime).toBe(200);
    expect(second.runtime.currentTime).toBe(100);
    expect(second.physics.getBodyTransform(second.bodyId)).not.toEqual(
      first.physics.getBodyTransform(first.bodyId),
    );
  });
});
