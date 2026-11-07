import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAVITY, JOINT_TARGET_KINDS, JOINT_TYPES } from './index';
import type { JointConfig, JointTarget, RigidBodyConfig } from './index';

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

/** Exhaustive switch used to prove that every joint target narrows to its scalar value. */
function targetValue(target: JointTarget): number {
  switch (target.kind) {
    case 'position':
    case 'velocity':
    case 'torque':
      return target.value;
    default:
      return assertNever(target);
  }
}

describe('joint type catalogue', () => {
  it('exposes the joint kinds of the design document', () => {
    expect(JOINT_TYPES).toEqual(['revolute', 'prismatic', 'spherical', 'fixed']);
  });

  it('lists the scalar joint commands', () => {
    expect(JOINT_TARGET_KINDS).toEqual(['position', 'velocity', 'torque']);
  });
});

describe('DEFAULT_GRAVITY', () => {
  it('points down the world Y axis', () => {
    expect(DEFAULT_GRAVITY).toEqual({ x: 0, y: -9.81, z: 0 });
    expect(DEFAULT_GRAVITY.y).toBeLessThan(0);
    expect(Object.isFrozen(DEFAULT_GRAVITY)).toBe(true);
  });
});

describe('physics descriptors', () => {
  it('narrows every joint target kind to its value', () => {
    const targets: readonly JointTarget[] = [
      { kind: 'position', value: Math.PI },
      { kind: 'velocity', value: -1 },
      { kind: 'torque', value: 0.25 },
    ];

    expect(targets.map((target) => target.kind)).toEqual(['position', 'velocity', 'torque']);
    expect(targets.map(targetValue)).toEqual([Math.PI, -1, 0.25]);
  });

  it('accepts a minimal rigid body and joint', () => {
    const body: RigidBodyConfig = { collider: { type: 'sphere', radius: 0.1 } };
    const joint: JointConfig = { type: 'revolute', bodyA: 'body-1' };

    expect(body.collider.type).toBe('sphere');
    expect(joint.type).toBe('revolute');
  });
});
