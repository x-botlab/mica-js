/**
 * 2D/3D math primitives shared by every layer of the scene package.
 *
 * Values are plain readonly objects and every helper is pure: it returns a new value instead of
 * mutating its inputs, so a transform can be shared between the document, the runtime and a
 * renderer without defensive copies. This also keeps the runtime deterministic — nothing here
 * depends on time, randomness or object identity.
 *
 * Units follow the `.scene3d` document: metres for lengths and radians for angles.
 */

/** A position, direction or extent in the 2D plane. */
export interface Vec2d {
  readonly x: number;
  readonly y: number;
}

/** A position or direction in 3D space. */
export interface Vec3d {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A rotation in quaternion form; `x`/`y`/`z` are the vector part and `w` the scalar part. */
export interface Quaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** Placement of an entity: translation, rotation and optional per-axis scale. */
export interface Transform {
  readonly position: Vec3d;
  readonly rotation: Quaternion;
  /** Per-axis scale; omitted means unit scale `(1, 1, 1)`. */
  readonly scale?: Vec3d;
}

const VEC3D_ZERO: Vec3d = Object.freeze({ x: 0, y: 0, z: 0 });
const VEC3D_ONE: Vec3d = Object.freeze({ x: 1, y: 1, z: 1 });
const VEC3D_UNIT_X: Vec3d = Object.freeze({ x: 1, y: 0, z: 0 });
const VEC3D_UNIT_Y: Vec3d = Object.freeze({ x: 0, y: 1, z: 0 });
const VEC3D_UNIT_Z: Vec3d = Object.freeze({ x: 0, y: 0, z: 1 });

const QUATERNION_IDENTITY: Quaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function vecAdd(a: Vec3d, b: Vec3d): Vec3d {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vecSub(a: Vec3d, b: Vec3d): Vec3d {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecScale(v: Vec3d, factor: number): Vec3d {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

function vecDot(a: Vec3d, b: Vec3d): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Right-handed cross product `a × b`. */
function vecCross(a: Vec3d, b: Vec3d): Vec3d {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function vecLength(v: Vec3d): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** Unit vector in the direction of `v`; a zero-length vector has no direction and becomes zero. */
function vecNormalize(v: Vec3d): Vec3d {
  const magnitude = vecLength(v);
  return magnitude === 0 ? VEC3D_ZERO : vecScale(v, 1 / magnitude);
}

function vecEquals(a: Vec3d, b: Vec3d, epsilon = 0): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.z - b.z) <= epsilon
  );
}

/** Hamilton product `a * b`: the rotation of `b` followed by the rotation of `a`. */
function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Unit quaternion of `radians` around `axis`; a zero-length axis has no rotation. */
function quatFromAxisAngle(axis: Vec3d, radians: number): Quaternion {
  const magnitude = vecLength(axis);
  if (magnitude === 0) {
    return QUATERNION_IDENTITY;
  }
  const half = radians / 2;
  const sinHalf = Math.sin(half) / magnitude;
  return {
    x: axis.x * sinHalf,
    y: axis.y * sinHalf,
    z: axis.z * sinHalf,
    w: Math.cos(half),
  };
}

/**
 * Quaternion of an intrinsic rotation about X, then Y, then Z — the order Three.js calls `'XYZ'`.
 * Angles are radians.
 */
function quatFromEuler(x: number, y: number, z: number): Quaternion {
  const qx = quatFromAxisAngle(VEC3D_UNIT_X, x);
  const qy = quatFromAxisAngle(VEC3D_UNIT_Y, y);
  const qz = quatFromAxisAngle(VEC3D_UNIT_Z, z);
  return quatMultiply(quatMultiply(qx, qy), qz);
}

/** Inverse rotation of a unit quaternion. */
function quatConjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Unit quaternion in the direction of `q`; a zero quaternion becomes the identity. */
function quatNormalize(q: Quaternion): Quaternion {
  const magnitude = Math.hypot(q.x, q.y, q.z, q.w);
  if (magnitude === 0) {
    return QUATERNION_IDENTITY;
  }
  const inverse = 1 / magnitude;
  return { x: q.x * inverse, y: q.y * inverse, z: q.z * inverse, w: q.w * inverse };
}

/**
 * Rotates `v` by `q` (`q * v * q⁻¹`).
 *
 * `q` is expected to be a unit quaternion — {@link Quaternion.fromAxisAngle} and
 * {@link Quaternion.fromEuler} already return one, and normalizing on every call would only add a
 * square root.
 */
function quatRotate(q: Quaternion, v: Vec3d): Vec3d {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function quatEquals(a: Quaternion, b: Quaternion, epsilon = 0): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.z - b.z) <= epsilon &&
    Math.abs(a.w - b.w) <= epsilon
  );
}

const TRANSFORM_IDENTITY: Transform = Object.freeze({
  position: VEC3D_ZERO,
  rotation: QUATERNION_IDENTITY,
  scale: VEC3D_ONE,
});

/** Builds a transform; `rotation` defaults to the identity and an omitted `scale` means unit scale. */
function transformFrom(
  position: Vec3d,
  rotation: Quaternion = QUATERNION_IDENTITY,
  scale?: Vec3d,
): Transform {
  return scale === undefined ? { position, rotation } : { position, rotation, scale };
}

/**
 * Constructors and helpers for {@link Vec3d}.
 *
 * Shared constants are frozen, so any number of entities can reference {@link Vec3d.zero} or
 * {@link Vec3d.unitZ} without copying it.
 */
export const Vec3d = {
  zero: VEC3D_ZERO,
  one: VEC3D_ONE,
  unitX: VEC3D_UNIT_X,
  unitY: VEC3D_UNIT_Y,
  unitZ: VEC3D_UNIT_Z,
  add: vecAdd,
  sub: vecSub,
  scale: vecScale,
  dot: vecDot,
  cross: vecCross,
  length: vecLength,
  normalize: vecNormalize,
  equals: vecEquals,
} as const;

/** Constructors and helpers for {@link Quaternion}. */
export const Quaternion = {
  identity: QUATERNION_IDENTITY,
  fromAxisAngle: quatFromAxisAngle,
  fromEuler: quatFromEuler,
  multiply: quatMultiply,
  conjugate: quatConjugate,
  normalize: quatNormalize,
  rotate: quatRotate,
  equals: quatEquals,
} as const;

/** Constants and constructors for {@link Transform}. */
export const Transform = {
  identity: TRANSFORM_IDENTITY,
  from: transformFrom,
} as const;
