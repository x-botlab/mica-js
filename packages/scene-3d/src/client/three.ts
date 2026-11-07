/** Optional Three.js adapter for acrylic meshes. */
import * as THREE from 'three';
import type { MaterialLibrary } from '../format/materials';
import { buildAcrylicMesh, resolveAcrylicMaterial } from '../geometry/acrylic';
import type { AcrylicDefinition, AcrylicPaint } from '../geometry/acrylic';

export { createThreeScene3DView } from './three-view';
export type { ThreeScene3DView, ThreeScene3DViewOptions } from './three-view';

/** One painted rectangle in UV space, ready to fill on a canvas. */
export interface PaintRectangle {
  readonly u: number;
  readonly v: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

/**
 * Maps printed strokes onto the UV square of a plate.
 *
 * Pure geometry, so it is testable without a canvas: `bounds` is the world-space AABB the mesh UVs
 * are normalized against, which keeps the sampled colour and the rendered texture in sync.
 */
export function acrylicPaintRectangles(
  paint: AcrylicPaint,
  bounds: {
    readonly min: { readonly x: number; readonly z: number };
    readonly max: { readonly x: number; readonly z: number };
  },
): readonly PaintRectangle[] {
  const width = bounds.max.x - bounds.min.x || 1;
  const depth = bounds.max.z - bounds.min.z || 1;
  const rectangles: PaintRectangle[] = [];

  if (paint.base !== undefined) {
    rectangles.push({ u: 0, v: 0, width: 1, height: 1, color: paint.base });
  }
  for (const stroke of paint.strokes ?? []) {
    const center = stroke.center - (stroke.axis === 'z' ? bounds.min.x : bounds.min.z);
    const extent = stroke.axis === 'z' ? width : depth;
    const start = (center - stroke.width / 2) / extent;
    const size = stroke.width / extent;
    rectangles.push(
      stroke.axis === 'z'
        ? { u: start, v: 0, width: size, height: 1, color: stroke.color }
        : { u: 0, v: start, width: 1, height: size, color: stroke.color },
    );
  }
  return rectangles;
}

/**
 * Rasterizes printed artwork into a texture.
 *
 * Returns `null` outside a DOM (Node tests, headless hosts), where there is nothing to draw on.
 */
export function createAcrylicPaintTexture(
  definition: AcrylicDefinition,
  meshBounds: {
    readonly min: { readonly x: number; readonly z: number };
    readonly max: { readonly x: number; readonly z: number };
  },
  size = 256,
): THREE.CanvasTexture | null {
  const paint = definition.paint;
  if (paint === undefined || typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) return null;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  for (const rectangle of acrylicPaintRectangles(paint, meshBounds)) {
    context.fillStyle = rectangle.color;
    // UV v runs along −Z after the extrusion flips the contour, so the canvas is drawn mirrored.
    context.fillRect(
      rectangle.u * size,
      (1 - rectangle.v - rectangle.height) * size,
      Math.max(rectangle.width * size, 1),
      Math.max(rectangle.height * size, 1),
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

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
  const texture = createAcrylicPaintTexture(definition, mesh.bounds);
  const material = new THREE.MeshStandardMaterial({
    // A painted plate takes its colour from the texture, so the base colour must not tint it.
    color: texture === null ? (resolved.color ?? '#ffffff') : '#ffffff',
    metalness: resolved.metalness ?? 0,
    roughness: resolved.roughness ?? 0.8,
    opacity,
    transparent: opacity < 1,
    side: THREE.DoubleSide,
    ...(texture === null ? {} : { map: texture }),
  });
  return new THREE.Mesh(geometry, material);
}
