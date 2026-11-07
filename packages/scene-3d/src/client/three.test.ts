import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildAcrylicMesh } from '../geometry/acrylic/mesh';
import { createAcrylicThreeMesh, acrylicPaintRectangles } from './three';

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

  it('maps printed strokes onto the plate UV square', () => {
    const bounds = { min: { x: -0.2, z: -0.3 }, max: { x: 0.2, z: 0.3 } };
    const rectangles = acrylicPaintRectangles(
      {
        base: '#f5f5f5',
        strokes: [
          { axis: 'z', center: 0, width: 0.05, color: '#141414' },
          { axis: 'x', center: 0.1, width: 0.02, color: '#ff0000' },
        ],
      },
      bounds,
    );

    expect(rectangles).toHaveLength(3);
    expect(rectangles[0]).toMatchObject({ u: 0, v: 0, width: 1, height: 1 });
    // A Z stroke becomes a vertical band centred at u = 0.5 with 0.05 / 0.4 of the width.
    expect(rectangles[1]?.u).toBeCloseTo(0.5 - 0.0625, 6);
    expect(rectangles[1]?.width).toBeCloseTo(0.125, 6);
    expect(rectangles[1]?.height).toBe(1);
    // An X stroke becomes a horizontal band: (0.1 + 0.3) / 0.6 from the bottom edge.
    expect(rectangles[2]?.v).toBeCloseTo(0.4 / 0.6 - 0.01 / 0.6, 6);
    expect(rectangles[2]?.height).toBeCloseTo(0.02 / 0.6, 6);
    expect(rectangles[2]?.width).toBe(1);
  });

  it('skips the texture outside a DOM', () => {
    const definition = {
      contour: { type: 'rect' as const, width: 0.1, height: 0.1 },
      thickness: 0.003,
      paint: { base: '#ffffff', strokes: [] },
    };
    const mesh = createAcrylicThreeMesh(definition);

    // Vitest runs in Node here, so there is no canvas to draw on and no texture is attached.
    expect(mesh.material.map).toBeNull();
    expect(mesh.material.color.getHexString()).toBe('ffffff');
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
});
