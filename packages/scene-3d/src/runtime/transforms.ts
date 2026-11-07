/**
 * Transform-batch encoding shared by the host and the client.
 *
 * A frame is one `Float32Array` of `entityCount * TRANSFORM_STRIDE` floats instead of one message
 * per entity. Matrices are column-major so `THREE.Matrix4.fromArray()` consumes them without any
 * conversion on the main thread:
 *
 * ```
 * | m0  m4  m8  m12 |   m0..m2   rotation column 0
 * | m1  m5  m9  m13 |   m4..m6   rotation column 1
 * | m2  m6  m10 m14 |   m8..m10  rotation column 2
 * | m3  m7  m11 m15 |   m12..m14 translation
 * ```
 *
 * Entities without a rigid body (assemblies, joints, sensors) keep an identity matrix, so the
 * document order stays the batch order and the client never has to rebuild an index map.
 */

import type { SceneEntity } from '../entities';
import type { PhysicsRuntime } from '../physics';
import type { Quaternion, Vec3d } from '../math';
import { TRANSFORM_STRIDE } from './protocol';

/** Writes an identity matrix at `offset` (in floats). */
function writeIdentityMatrix(target: Float32Array, offset = 0): void {
  target.fill(0, offset, offset + TRANSFORM_STRIDE);
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 15] = 1;
}

/**
 * Writes a column-major TRS matrix with unit scale at `offset` (in floats).
 *
 * The quaternion is normalized first: a zero or slightly denormalized rotation from a physics
 * engine must not shear the mesh on screen.
 */
function writeTransformMatrix(
  target: Float32Array,
  offset: number,
  position: Vec3d,
  rotation: Quaternion,
): void {
  const magnitude = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  const w = magnitude === 0 ? 1 : rotation.w / magnitude;
  const x = magnitude === 0 ? 0 : rotation.x / magnitude;
  const y = magnitude === 0 ? 0 : rotation.y / magnitude;
  const z = magnitude === 0 ? 0 : rotation.z / magnitude;

  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  target[offset] = 1 - 2 * (yy + zz);
  target[offset + 1] = 2 * (xy + wz);
  target[offset + 2] = 2 * (xz - wy);
  target[offset + 3] = 0;

  target[offset + 4] = 2 * (xy - wz);
  target[offset + 5] = 1 - 2 * (xx + zz);
  target[offset + 6] = 2 * (yz + wx);
  target[offset + 7] = 0;

  target[offset + 8] = 2 * (xz + wy);
  target[offset + 9] = 2 * (yz - wx);
  target[offset + 10] = 1 - 2 * (xx + yy);
  target[offset + 11] = 0;

  target[offset + 12] = position.x;
  target[offset + 13] = position.y;
  target[offset + 14] = position.z;
  target[offset + 15] = 1;
}

/**
 * Reads the translation of entity `index` out of a transform batch.
 *
 * The client renders the raw batch; this helper exists for tests and tooling.
 */
export function readBatchTranslation(batch: Float32Array, index: number): Vec3d {
  const offset = index * TRANSFORM_STRIDE;
  return {
    x: batch[offset + 12] ?? 0,
    y: batch[offset + 13] ?? 0,
    z: batch[offset + 14] ?? 0,
  };
}

/**
 * Builds the transform batch of `entities` in one pass.
 *
 * Bodies are read through `physics.getBodyTransform`; everything else writes an identity matrix.
 * A fresh buffer is allocated every call, so callers can transfer or retain the result without the
 * next step mutating it.
 */
export function readTransformBatch(
  entities: readonly SceneEntity[],
  bodyIdFor: (entityId: string) => string | undefined,
  physics: PhysicsRuntime,
): Float32Array {
  const batch = new Float32Array(entities.length * TRANSFORM_STRIDE);

  for (let index = 0; index < entities.length; index++) {
    const entity = entities[index];
    const offset = index * TRANSFORM_STRIDE;
    if (entity === undefined) {
      writeIdentityMatrix(batch, offset);
      continue;
    }

    const bodyId = bodyIdFor(entity.id);
    if (bodyId === undefined) {
      writeIdentityMatrix(batch, offset);
      continue;
    }

    const { position, rotation } = physics.getBodyTransform(bodyId);
    writeTransformMatrix(batch, offset, position, rotation);
  }

  return batch;
}
