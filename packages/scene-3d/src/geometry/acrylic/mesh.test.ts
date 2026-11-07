import { describe, expect, it } from 'vitest';
import { buildAcrylicMesh } from './mesh';
import { parseAcrylicContour } from './contour';

const definition = {
  contour: { type: 'rect' as const, width: 0.1, height: 0.1 },
  thickness: 0.003,
};
const normalAt = (mesh: ReturnType<typeof buildAcrylicMesh>, index: number) => ({
  x: mesh.normals[index * 3],
  y: mesh.normals[index * 3 + 1],
  z: mesh.normals[index * 3 + 2],
});
const triangleArea = (
  mesh: ReturnType<typeof buildAcrylicMesh>,
  a: number,
  b: number,
  c: number,
) => {
  const ax = mesh.positions[a * 3]!,
    ay = mesh.positions[a * 3 + 1]!,
    az = mesh.positions[a * 3 + 2]!;
  const bx = mesh.positions[b * 3]!,
    by = mesh.positions[b * 3 + 1]!,
    bz = mesh.positions[b * 3 + 2]!;
  const cx = mesh.positions[c * 3]!,
    cy = mesh.positions[c * 3 + 1]!,
    cz = mesh.positions[c * 3 + 2]!;
  const ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  const vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
};
const triangleAreaXZ = (
  mesh: ReturnType<typeof buildAcrylicMesh>,
  a: number,
  b: number,
  c: number,
) => {
  const ax = mesh.positions[a * 3]!,
    az = mesh.positions[a * 3 + 2]!;
  const bx = mesh.positions[b * 3]!,
    bz = mesh.positions[b * 3 + 2]!;
  const cx = mesh.positions[c * 3]!,
    cz = mesh.positions[c * 3 + 2]!;
  return Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
};

describe('acrylic extrusion mesh', () => {
  it('creates independent cap and side vertices with correct normals', () => {
    const mesh = buildAcrylicMesh(definition);
    expect(mesh.positions.length / 3).toBe(24);
    expect(mesh.indices.length).toBe(36);
    expect(Array.from({ length: 4 }, (_, i) => normalAt(mesh, i))).toEqual([
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ]);
    expect(Array.from({ length: 4 }, (_, i) => normalAt(mesh, i + 4))).toEqual([
      { x: 0, y: -1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: -1, z: 0 },
    ]);
    for (let i = 8; i < 24; i += 1) {
      const normal = normalAt(mesh, i);
      expect(normal.y).toBe(0);
      expect(Math.hypot(normal.x!, normal.y!, normal.z!)).toBeCloseTo(1);
    }
    // The second rectangle edge runs along +Y in the contour plane: its +X normal is outward.
    expect(normalAt(mesh, 12)).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('triangulates holes without degenerate triangles and preserves area', () => {
    const contour = {
      type: 'compound' as const,
      outer: definition.contour,
      holes: [{ type: 'rect' as const, width: 0.02, height: 0.02 }],
    };
    const mesh = buildAcrylicMesh({ contour, thickness: 0.003 });
    const indices = mesh.indices;
    for (let i = 0; i < indices.length; i += 3) {
      expect(triangleArea(mesh, indices[i]!, indices[i + 1]!, indices[i + 2]!)).toBeGreaterThan(0);
    }
    let topArea = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]!,
        b = indices[i + 1]!,
        c = indices[i + 2]!;
      if (
        Math.abs(mesh.positions[a * 3 + 1]! - 0.0015) < 1e-6 &&
        Math.abs(mesh.positions[b * 3 + 1]! - 0.0015) < 1e-6 &&
        Math.abs(mesh.positions[c * 3 + 1]! - 0.0015) < 1e-6
      )
        topArea += triangleAreaXZ(mesh, a, b, c);
    }
    expect(topArea).toBeCloseTo(0.1 * 0.1 - 0.02 * 0.02, 2);
    expect(indices.length % 3).toBe(0);
  });

  it('normalizes UVs, bounds, volume and removes collinear contour points', () => {
    const contour = {
      type: 'polygon' as const,
      points: [
        { x: -0.05, y: -0.05 },
        { x: 0, y: -0.05 },
        { x: 0.05, y: -0.05 },
        { x: 0.05, y: 0.05 },
        { x: -0.05, y: 0.05 },
      ],
    };
    const mesh = buildAcrylicMesh({ contour, thickness: 0.003 });
    expect(mesh.positions.length / 3).toBe(24);
    expect(Math.min(...mesh.uvs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...mesh.uvs)).toBeLessThanOrEqual(1);
    expect(mesh.bounds.min.y).toBeCloseTo(-0.0015);
    expect(mesh.bounds.max.y).toBeCloseTo(0.0015);
    expect(mesh.volume).toBeCloseTo(0.1 * 0.1 * 0.003);
    expect(mesh.bounds.min.x).toBeCloseTo(-0.05);
    expect(mesh.bounds.max.z).toBeCloseTo(0.05);
    expect(parseAcrylicContour(contour).rings[0]).toHaveLength(5);
  });

  it('winds every triangle so its face normal matches its vertex normals', () => {
    const mesh = buildAcrylicMesh({
      contour: {
        type: 'compound',
        outer: definition.contour,
        holes: [{ type: 'rect', width: 0.02, height: 0.02 }],
      },
      thickness: 0.003,
    });
    const indices = mesh.indices;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
      const face = faceNormal(mesh, a, b, c);
      const vertex = normalAt(mesh, a);
      const dot = face.x * vertex.x! + face.y * vertex.y! + face.z * vertex.z!;
      expect(dot).toBeGreaterThan(0.99);
    }
  });

  it('points hole walls into the hole and outer walls away from the material', () => {
    const mesh = buildAcrylicMesh({
      contour: {
        type: 'compound',
        outer: definition.contour,
        holes: [{ type: 'rect', width: 0.02, height: 0.02 }],
      },
      thickness: 0.003,
    });
    const wallNormals: {
      centroid: { x: number; z: number };
      normal: ReturnType<typeof normalAt>;
    }[] = [];
    const indices = mesh.indices;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
      const normal = normalAt(mesh, a);
      if (Math.abs(normal.y!) > 1e-9) continue; // cap triangle
      wallNormals.push({
        centroid: {
          x: (mesh.positions[a * 3]! + mesh.positions[b * 3]! + mesh.positions[c * 3]!) / 3,
          z:
            (mesh.positions[a * 3 + 2]! + mesh.positions[b * 3 + 2]! + mesh.positions[c * 3 + 2]!) /
            3,
        },
        normal,
      });
    }

    expect(wallNormals).toHaveLength(16); // 8 ring edges, two triangles each
    for (const { centroid, normal } of wallNormals) {
      const outward = normal.x! * centroid.x + normal.z! * centroid.z;
      // Walls sit at |x| or |z| = 0.05 (outer) or 0.01 (hole); the sign tells them apart.
      const onOuterRing =
        Math.abs(Math.abs(centroid.x) - 0.05) < 1e-6 ||
        Math.abs(Math.abs(centroid.z) - 0.05) < 1e-6;
      if (onOuterRing) expect(outward).toBeGreaterThan(0);
      else expect(outward).toBeLessThan(0);
    }
  });
});

function faceNormal(
  mesh: ReturnType<typeof buildAcrylicMesh>,
  a: number,
  b: number,
  c: number,
): { x: number; y: number; z: number } {
  const point = (index: number) => ({
    x: mesh.positions[index * 3]!,
    y: mesh.positions[index * 3 + 1]!,
    z: mesh.positions[index * 3 + 2]!,
  });
  const p0 = point(a);
  const p1 = point(b);
  const p2 = point(c);
  const ux = p1.x - p0.x;
  const uy = p1.y - p0.y;
  const uz = p1.z - p0.z;
  const vx = p2.x - p0.x;
  const vy = p2.y - p0.y;
  const vz = p2.z - p0.z;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}
