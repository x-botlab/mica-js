/**
 * Minimal Three.js implementation of {@link Scene3DView}.
 *
 * This is intentionally a *thin* adapter: it maps entities to placeholder primitives, applies the
 * transform batch the host sends and draws one frame. Editor-grade scene construction (materials
 * from presets, textures, shadows, gizmos, picking) belongs to the editor, which can replace this
 * view without touching `Scene3DClient` or the sandboxed host.
 *
 * ```ts
 * const view = createThreeScene3DView({ canvas });
 * const client = await Scene3DClient.create({ document, view, createHost });
 * ```
 */

import * as THREE from 'three';
import type { GeometryDescriptor, ModelEntity, SceneEntity } from '../entities';
import { createAcrylicThreeMesh } from './three';
import { TRANSFORM_STRIDE } from '../runtime/protocol';
import type { Scene3DView } from './client';

/** Options of {@link createThreeScene3DView}. */
export interface ThreeScene3DViewOptions {
  /** Main-thread canvas the renderer draws into. */
  readonly canvas: HTMLCanvasElement;
  /** Reuse an existing renderer instead of creating one; the caller then owns it. */
  readonly renderer?: THREE.WebGLRenderer;
  /** Reuse an existing camera; defaults to a perspective camera framing the origin. */
  readonly camera?: THREE.Camera;
  /** Scene background; defaults to a dark neutral colour. */
  readonly background?: THREE.ColorRepresentation;
}

/** Three.js view, exposing its scene graph for editor integration. */
export interface ThreeScene3DView extends Scene3DView {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly renderer: THREE.WebGLRenderer;
}

interface ViewEntity {
  readonly object: THREE.Object3D;
  readonly resources: readonly { dispose(): void }[];
}

/** Creates a Three.js view for a main-thread canvas. */
export function createThreeScene3DView(options: ThreeScene3DViewOptions): ThreeScene3DView {
  if (typeof options !== 'object' || options === null || options.canvas === undefined) {
    throw new TypeError('createThreeScene3DView: options.canvas is required');
  }

  const canvas = options.canvas;
  const ownsRenderer = options.renderer === undefined;
  const renderer = options.renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? '#101318');

  const camera =
    options.camera ??
    new THREE.PerspectiveCamera(60, canvas.width / Math.max(canvas.height, 1), 0.1, 1000);
  camera.position.set(0, 2, 6);
  camera.lookAt(0, 0, 0);
  scene.add(camera);

  // Placeholder lighting: enough to see the primitives until environment presets are applied.
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(3, 6, 4);
  scene.add(keyLight);

  const entities = new Map<string, ViewEntity>();
  const matrix = new THREE.Matrix4();
  let disposed = false;

  const view: ThreeScene3DView = {
    scene,
    camera,
    renderer,

    addEntity(entity: SceneEntity): void {
      if (disposed) throw new Error('ThreeScene3DView.addEntity: the view has been disposed');
      if (entities.has(entity.id)) {
        throw new Error(`ThreeScene3DView.addEntity: entity "${entity.id}" already exists`);
      }

      const created = createViewEntity(entity);
      entities.set(entity.id, created);
      scene.add(created.object);
      // Until the host sends the first batch, the document pose is the best guess.
      placeObject(created.object, entity.position, entity.rotation);
    },

    removeEntity(id: string): void {
      const existing = entities.get(id);
      if (existing === undefined) return;
      entities.delete(id);
      scene.remove(existing.object);
      for (const resource of existing.resources) resource.dispose();
    },

    applyTransforms(transforms: Float32Array): void {
      if (disposed) {
        throw new Error('ThreeScene3DView.applyTransforms: the view has been disposed');
      }
      const expected = entities.size * TRANSFORM_STRIDE;
      if (transforms.length !== expected) {
        throw new RangeError(
          `ThreeScene3DView.applyTransforms: expected ${String(expected)} floats, ` +
            `received ${String(transforms.length)}`,
        );
      }

      let index = 0;
      for (const created of entities.values()) {
        matrix.fromArray(transforms, index * TRANSFORM_STRIDE);
        created.object.matrix.copy(matrix);
        created.object.matrixAutoUpdate = false;
        created.object.matrixWorldNeedsUpdate = true;
        index++;
      }
    },

    render(): void {
      if (disposed) throw new Error('ThreeScene3DView.render: the view has been disposed');
      renderer.render(scene, camera);
    },

    resize(width: number, height: number): void {
      if (disposed) throw new Error('ThreeScene3DView.resize: the view has been disposed');
      renderer.setSize(width, height, false);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;

      for (const created of entities.values()) {
        scene.remove(created.object);
        for (const resource of created.resources) resource.dispose();
      }
      entities.clear();

      if (ownsRenderer) renderer.dispose();
    },
  };

  return view;
}

function createViewEntity(entity: SceneEntity): ViewEntity {
  if (isModelEntity(entity)) {
    if (entity.geometry.type === 'acrylic') {
      const mesh = createAcrylicThreeMesh(entity.geometry.acrylic);
      mesh.name = entity.id;
      return { object: mesh, resources: [mesh.geometry, mesh.material] };
    }
    const geometry = createGeometry(entity.geometry);
    const opacity = entity.material.opacity ?? 1;
    const material = new THREE.MeshStandardMaterial({
      color: entity.material.color ?? '#c8ccd4',
      metalness: entity.material.metalness ?? 0.1,
      roughness: entity.material.roughness ?? 0.8,
      opacity,
      transparent: opacity < 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = entity.id;
    return { object: mesh, resources: [geometry, material] };
  }

  // Assemblies, joints and sensors render through their own entities; until those visual kinds
  // land, they are empty groups so transforms and lifecycle already work.
  const group = new THREE.Group();
  group.name = entity.id;
  return { object: group, resources: [] };
}

function createGeometry(geometry: GeometryDescriptor): THREE.BufferGeometry {
  switch (geometry.type) {
    case 'box':
      return new THREE.BoxGeometry(geometry.size.x, geometry.size.y, geometry.size.z);
    case 'sphere':
      return new THREE.SphereGeometry(geometry.radius, 24, 16);
    case 'cylinder':
      return new THREE.CylinderGeometry(geometry.radius, geometry.radius, geometry.height, 24);
    case 'capsule':
      return new THREE.CapsuleGeometry(
        geometry.radius,
        Math.max(geometry.height - geometry.radius * 2, 0.0001),
        8,
        16,
      );
    case 'plane':
      return new THREE.PlaneGeometry(geometry.size.x, geometry.size.y);
    case 'acrylic':
      return new THREE.BufferGeometry();
  }
}

/** `SceneEntity` is a base interface rather than a union, so narrowing needs an explicit guard. */
function isModelEntity(entity: SceneEntity): entity is ModelEntity {
  return entity.type === 'model';
}

function placeObject(
  object: THREE.Object3D,
  position: { readonly x: number; readonly y: number; readonly z: number },
  rotation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
): void {
  object.position.set(position.x, position.y, position.z);
  object.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
  object.updateMatrix();
  object.matrixAutoUpdate = false;
}
