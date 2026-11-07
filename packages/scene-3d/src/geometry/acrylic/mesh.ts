import earcut from 'earcut';
import type { Vec2d } from '../../math';
import { parseAcrylicContour, validateAcrylicDefinition } from './contour';
import type {
  AcrylicDefinition,
  AcrylicMesh,
  AcrylicContourOptions,
  AcrylicRing,
  ParsedAcrylicContour,
} from './types';

const EPS = 1e-10;
function cross(a: Vec2d, b: Vec2d, c: Vec2d): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function collinear(a: Vec2d, b: Vec2d, c: Vec2d): boolean {
  return (
    Math.abs(cross(a, b, c)) <= EPS &&
    b.x >= Math.min(a.x, c.x) - EPS &&
    b.x <= Math.max(a.x, c.x) + EPS &&
    b.y >= Math.min(a.y, c.y) - EPS &&
    b.y <= Math.max(a.y, c.y) + EPS
  );
}
function removeCollinear(points: readonly Vec2d[]): Vec2d[] {
  const result = [...points];
  let changed = true;
  while (changed && result.length > 3) {
    changed = false;
    for (let i = 0; i < result.length; i += 1) {
      if (
        collinear(
          result[(i + result.length - 1) % result.length]!,
          result[i]!,
          result[(i + 1) % result.length]!,
        )
      ) {
        result.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}
function normalized(parsed: ParsedAcrylicContour): ParsedAcrylicContour {
  const rings: AcrylicRing[] = parsed.rings.map((ring) => removeCollinear(ring));
  return { ...parsed, rings };
}
function shifted(
  parsed: ParsedAcrylicContour,
  definition: AcrylicDefinition,
): ParsedAcrylicContour {
  const origin = definition.origin ?? 'center';
  const offset =
    origin === 'center'
      ? {
          x: (parsed.bounds.min.x + parsed.bounds.max.x) / 2,
          y: (parsed.bounds.min.y + parsed.bounds.max.y) / 2,
        }
      : origin === 'min'
        ? parsed.bounds.min
        : origin === 'max'
          ? parsed.bounds.max
          : origin;
  const rings = parsed.rings.map((ring) =>
    ring.map((point) => ({ x: point.x - offset.x, y: point.y - offset.y })),
  );
  return {
    ...parsed,
    rings,
    bounds: {
      min: { x: parsed.bounds.min.x - offset.x, y: parsed.bounds.min.y - offset.y },
      max: { x: parsed.bounds.max.x - offset.x, y: parsed.bounds.max.y - offset.y },
    },
  };
}
function triangulate(parsed: ParsedAcrylicContour): {
  points: Vec2d[];
  holeIndices: number[];
  indices: Uint32Array;
} {
  const points: Vec2d[] = [];
  const holeIndices: number[] = [];
  for (let ringIndex = 0; ringIndex < parsed.rings.length; ringIndex += 1) {
    const ring = parsed.rings[ringIndex]!;
    if (ringIndex > 0) holeIndices.push(points.length);
    points.push(...ring);
  }
  const flat = points.flatMap((point) => [point.x, point.y]);
  return { points, holeIndices, indices: Uint32Array.from(earcut(flat, holeIndices, 2)) };
}

/**
 * Build a deterministic Y-up extrusion. Vertices are separated by face group so normals can be
 * used directly for rendering: cap vertices are flat ±Y and every side edge has its own outward
 * horizontal normal.
 */
export function buildAcrylicMesh(
  definition: AcrylicDefinition,
  options: AcrylicContourOptions = {},
): AcrylicMesh {
  validateAcrylicDefinition(definition);
  const parsed = shifted(normalized(parseAcrylicContour(definition.contour, options)), definition);
  const { points, indices: topTriangles } = triangulate(parsed);
  const half = definition.thickness / 2;
  const width = parsed.bounds.max.x - parsed.bounds.min.x || 1;
  const height = parsed.bounds.max.y - parsed.bounds.min.y || 1;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const write = (
    point: Vec2d,
    y: number,
    normal: Vec2d | { readonly x: number; readonly y: number; readonly z: number },
    u: number,
    v: number,
  ): number => {
    const index = positions.length / 3;
    positions.push(point.x, y, point.y);
    normals.push(normal.x || 0, normal.y || 0, ('z' in normal ? normal.z : 0) || 0);
    uvs.push(u, v);
    return index;
  };
  const capTop: number[] = [];
  const capBottom: number[] = [];
  for (const point of points) {
    const u = (point.x - parsed.bounds.min.x) / width;
    const v = (point.y - parsed.bounds.min.y) / height;
    capTop.push(write(point, half, { x: 0, y: 1, z: 0 }, u, v));
  }
  for (const point of points) {
    const u = (point.x - parsed.bounds.min.x) / width;
    const v = (point.y - parsed.bounds.min.y) / height;
    capBottom.push(write(point, -half, { x: 0, y: -1, z: 0 }, u, v));
  }
  for (let i = 0; i < topTriangles.length; i += 3) {
    const a = topTriangles[i]!,
      b = topTriangles[i + 1]!,
      c = topTriangles[i + 2]!;
    const winding = cross(points[a]!, points[b]!, points[c]!);
    if (winding >= 0) {
      indices.push(capTop[a]!, capTop[c]!, capTop[b]!);
      indices.push(capBottom[a]!, capBottom[b]!, capBottom[c]!);
    } else {
      indices.push(capTop[a]!, capTop[b]!, capTop[c]!);
      indices.push(capBottom[a]!, capBottom[c]!, capBottom[b]!);
    }
  }
  for (let ringIndex = 0; ringIndex < parsed.rings.length; ringIndex += 1) {
    const ring = parsed.rings[ringIndex]!;
    let perimeter = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    perimeter ||= 1;
    let distance = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const u0 = distance / perimeter;
      const u1 = (distance + length) / perimeter;
      // `parseAcrylicContour` hands over a CCW outer ring and CW holes, and the contour plane maps
      // to world XZ (`contour.y` → world z). `(dy, -dx)` is the outward direction for a CCW loop,
      // which for a CW hole ring points into the hole — exactly the face the wall must show.
      const normal = { x: dy / length, y: 0, z: -dx / length };
      const aTop = write(a, half, normal, u0, 1);
      const aBottom = write(a, -half, normal, u0, 0);
      const bBottom = write(b, -half, normal, u1, 0);
      const bTop = write(b, half, normal, u1, 1);
      indices.push(aTop, bTop, bBottom, aTop, bBottom, aBottom);
      distance += length;
    }
  }
  const bounds = {
    min: { x: parsed.bounds.min.x, y: -half, z: parsed.bounds.min.y },
    max: { x: parsed.bounds.max.x, y: half, z: parsed.bounds.max.y },
  };
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    bounds,
    volume: parsed.area * definition.thickness,
  };
}
export const createAcrylicMesh = buildAcrylicMesh;
/** Exposed for callers that need the deterministic top/bottom triangulation. */
export function triangulateAcrylicContour(
  contour: AcrylicDefinition['contour'],
  options: AcrylicContourOptions = {},
): Uint32Array {
  const parsed = normalized(parseAcrylicContour(contour, options));
  return triangulate(parsed).indices;
}
