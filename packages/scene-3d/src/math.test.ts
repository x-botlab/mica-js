import { describe, expect, it } from 'vitest';
import { Quaternion, Transform, Vec3d } from './index';

describe('Vec3d', () => {
  it('exposes frozen shared constants', () => {
    expect(Vec3d.zero).toEqual({ x: 0, y: 0, z: 0 });
    expect(Vec3d.one).toEqual({ x: 1, y: 1, z: 1 });
    expect(Vec3d.unitX).toEqual({ x: 1, y: 0, z: 0 });
    expect(Vec3d.unitY).toEqual({ x: 0, y: 1, z: 0 });
    expect(Vec3d.unitZ).toEqual({ x: 0, y: 0, z: 1 });
    expect(Object.isFrozen(Vec3d.zero)).toBe(true);
  });

  it('adds, subtracts and scales without touching its inputs', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { x: -1, y: 4, z: 0 };

    expect(Vec3d.add(a, b)).toEqual({ x: 0, y: 6, z: 3 });
    expect(Vec3d.sub(a, b)).toEqual({ x: 2, y: -2, z: 3 });
    expect(Vec3d.scale(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
    expect(a).toEqual({ x: 1, y: 2, z: 3 });
    expect(b).toEqual({ x: -1, y: 4, z: 0 });
  });

  it('computes dot, cross and length', () => {
    expect(Vec3d.dot(Vec3d.unitX, Vec3d.unitY)).toBe(0);
    expect(Vec3d.dot(Vec3d.unitX, Vec3d.unitX)).toBe(1);
    expect(Vec3d.cross(Vec3d.unitX, Vec3d.unitY)).toEqual(Vec3d.unitZ);
    expect(Vec3d.length({ x: 3, y: 4, z: 0 })).toBe(5);
  });

  it('normalizes to unit length and maps a zero vector to zero', () => {
    const unit = Vec3d.normalize({ x: 3, y: 4, z: 0 });

    expect(Vec3d.length(unit)).toBeCloseTo(1);
    expect(unit.x).toBeCloseTo(0.6);
    expect(unit.y).toBeCloseTo(0.8);
    expect(unit.z).toBeCloseTo(0);
    expect(Vec3d.normalize(Vec3d.zero)).toBe(Vec3d.zero);
  });

  it('compares component-wise with an epsilon', () => {
    const a = { x: 1, y: 2, z: 3 };

    expect(Vec3d.equals(a, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(Vec3d.equals(a, { x: 1.001, y: 2, z: 3 })).toBe(false);
    expect(Vec3d.equals(a, { x: 1.001, y: 2, z: 3 }, 0.01)).toBe(true);
  });
});

describe('Quaternion', () => {
  it('starts from the identity', () => {
    expect(Quaternion.identity).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(Quaternion.rotate(Quaternion.identity, { x: 1, y: 2, z: 3 })).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
  });

  it('rotates a vector a quarter turn around an axis', () => {
    const q = Quaternion.fromAxisAngle(Vec3d.unitZ, Math.PI / 2);
    const rotated = Quaternion.rotate(q, Vec3d.unitX);

    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(1);
    expect(rotated.z).toBeCloseTo(0);
  });

  it('normalizes the axis and ignores a zero-length one', () => {
    const q = Quaternion.fromAxisAngle({ x: 0, y: 0, z: 2 }, Math.PI / 2);
    const rotated = Quaternion.rotate(q, Vec3d.unitX);

    expect(rotated.y).toBeCloseTo(1);
    expect(Quaternion.equals(Quaternion.fromAxisAngle(Vec3d.zero, 1), Quaternion.identity)).toBe(
      true,
    );
  });

  it('composes Euler rotations in intrinsic X → Y → Z order', () => {
    expect(Quaternion.equals(Quaternion.fromEuler(0, 0, 0), Quaternion.identity)).toBe(true);
    expect(
      Quaternion.equals(
        Quaternion.fromEuler(Math.PI / 2, 0, 0),
        Quaternion.fromAxisAngle(Vec3d.unitX, Math.PI / 2),
      ),
    ).toBe(true);

    // Intrinsic X then Y: the Y turn maps +Z to +X first, then the X turn leaves +X in place.
    const composed = Quaternion.fromEuler(Math.PI / 2, Math.PI / 2, 0);
    const rotated = Quaternion.rotate(composed, Vec3d.unitZ);

    expect(rotated.x).toBeCloseTo(1);
    expect(rotated.y).toBeCloseTo(0);
    expect(rotated.z).toBeCloseTo(0);
  });

  it('multiplies rotations, conjugates and normalizes', () => {
    const qx = Quaternion.fromAxisAngle(Vec3d.unitX, Math.PI / 2);
    const qy = Quaternion.fromAxisAngle(Vec3d.unitY, Math.PI / 2);

    const rotated = Quaternion.rotate(Quaternion.multiply(qx, qy), Vec3d.unitZ);
    expect(rotated.x).toBeCloseTo(1);
    expect(rotated.y).toBeCloseTo(0);
    expect(rotated.z).toBeCloseTo(0);

    const inverse = Quaternion.conjugate(qx);
    expect(Quaternion.equals(Quaternion.multiply(qx, inverse), Quaternion.identity, 1e-12)).toBe(
      true,
    );

    const scaled = { x: qx.x * 2, y: qx.y * 2, z: qx.z * 2, w: qx.w * 2 };
    expect(Quaternion.equals(Quaternion.normalize(scaled), qx, 1e-12)).toBe(true);
    expect(Quaternion.normalize({ x: 0, y: 0, z: 0, w: 0 })).toBe(Quaternion.identity);
  });

  it('compares component-wise with an epsilon', () => {
    const q = Quaternion.fromAxisAngle(Vec3d.unitY, 1);

    expect(Quaternion.equals(q, { ...q })).toBe(true);
    expect(Quaternion.equals(q, { ...q, w: q.w + 1e-9 })).toBe(false);
    expect(Quaternion.equals(q, { ...q, w: q.w + 1e-9 }, 1e-8)).toBe(true);
  });
});

describe('public types', () => {
  it('exposes every interface and its helper object under the same name', () => {
    const origin: Vec3d = Vec3d.zero;
    const rotation: Quaternion = Quaternion.identity;
    const placement: Transform = Transform.identity;

    expect(origin).toBe(Vec3d.zero);
    expect(rotation).toBe(Quaternion.identity);
    expect(placement).toBe(Transform.identity);
  });
});

describe('Transform', () => {
  it('has an identity transform built from the shared constants', () => {
    expect(Transform.identity.position).toBe(Vec3d.zero);
    expect(Transform.identity.rotation).toBe(Quaternion.identity);
    expect(Transform.identity.scale).toBe(Vec3d.one);
    expect(Object.isFrozen(Transform.identity)).toBe(true);
  });

  it('defaults the rotation to the identity and leaves the scale unset', () => {
    const position = { x: 1, y: 2, z: 3 };
    const transform = Transform.from(position);

    expect(transform).toEqual({ position, rotation: Quaternion.identity });
    expect('scale' in transform).toBe(false);
  });

  it('keeps an explicit rotation and scale', () => {
    const position = { x: 1, y: 2, z: 3 };
    const rotation = Quaternion.fromAxisAngle(Vec3d.unitX, Math.PI / 4);
    const scale = { x: 2, y: 2, z: 2 };

    expect(Transform.from(position, rotation, scale)).toEqual({ position, rotation, scale });
  });
});
