/** Optional Three.js adapter for acrylic meshes. */
import * as THREE from 'three';
import type { MaterialLibrary } from '../format/materials';
import { buildAcrylicMesh, resolveAcrylicMaterial } from '../geometry/acrylic';
import type { AcrylicDefinition } from '../geometry/acrylic';

export { createThreeScene3DView } from './three-view';
export type { ThreeScene3DView, ThreeScene3DViewOptions } from './three-view';

/** Build a renderable Three.js mesh from a deterministic acrylic extrusion. */
export function createAcrylicThreeMesh(
  definition: AcrylicDefinition,
  library?: MaterialLibrary,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const mesh = buildAcrylicMesh(definition);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uvs, 2));
  geometry.setIndex(new THREE.Uint32BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const resolved = resolveAcrylicMaterial(definition, library);
  const opacity = resolved.opacity ?? 1;
  const material = new THREE.MeshStandardMaterial({
    color: resolved.color ?? '#ffffff',
    metalness: resolved.metalness ?? 0,
    roughness: resolved.roughness ?? 0.8,
    opacity,
    transparent: opacity < 1,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}
