import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildAcrylicMesh } from '../geometry/acrylic/mesh';
import { createAcrylicThreeMesh } from './three';

describe('acrylic Three.js adapter', () => {
  it('creates matching geometry attributes and material properties', () => {
    const definition = {
      contour: { type: 'rect' as const, width: 0.1, height: 0.2 },
      thickness: 0.003,
      material: { preset: 'acrylic', opacity: 0.6 },
    };
    const source = buildAcrylicMesh(definition);
    const mesh = createAcrylicThreeMesh(definition);
    const geometry = mesh.geometry;
    expect(geometry.getAttribute('position').count).toBe(source.positions.length / 3);
    expect(geometry.getAttribute('normal').count).toBe(source.normals.length / 3);
    expect(geometry.getAttribute('uv').count).toBe(source.uvs.length / 2);
    expect(geometry.index?.count).toBe(source.indices.length);
    expect(geometry.boundingBox?.min.x).toBeCloseTo(source.bounds.min.x);
    expect(geometry.boundingBox?.max.y).toBeCloseTo(source.bounds.max.y);
    const material = mesh.material;
    expect(material.transparent).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);
    mesh.geometry.dispose();
    material.dispose();
  });
});
