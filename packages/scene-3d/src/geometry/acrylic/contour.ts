import type { Vec2d } from '../../math';
import type {
  AcrylicContour,
  AcrylicContourOptions,
  AcrylicDefinition,
  AcrylicRing,
  ParsedAcrylicContour,
} from './types';

const EPS = 1e-10;
const DEFAULT_SEGMENTS = 64;
const DEFAULT_CURVE_SEGMENTS = 16;

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const same = (a: Vec2d, b: Vec2d): boolean =>
  Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
const cross = (a: Vec2d, b: Vec2d, c: Vec2d): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function signedArea(points: readonly Vec2d[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}
function clean(points: readonly Vec2d[]): Vec2d[] {
  const result: Vec2d[] = [];
  for (const point of points)
    if (result.length === 0 || !same(result[result.length - 1]!, point))
      result.push({ x: point.x, y: point.y });
  if (result.length > 1 && same(result[0]!, result[result.length - 1]!)) result.pop();
  return result;
}
function ensureSegments(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 3)
    throw new RangeError('segmentCount must be an integer >= 3');
  return result;
}
function roundedRect(width: number, height: number, radius: number, segments: number): Vec2d[] {
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0)
    return [
      { x: -width / 2, y: -height / 2 },
      { x: width / 2, y: -height / 2 },
      { x: width / 2, y: height / 2 },
      { x: -width / 2, y: height / 2 },
    ];
  const points: Vec2d[] = [];
  const perCorner = Math.max(1, Math.ceil(segments / 16));
  const corners = [
    [width / 2 - r, height / 2 - r, 0],
    [-width / 2 + r, height / 2 - r, Math.PI / 2],
    [-width / 2 + r, -height / 2 + r, Math.PI],
    [width / 2 - r, -height / 2 + r, Math.PI * 1.5],
  ] as const;
  for (const [cx, cy, start] of corners)
    for (let i = 0; i <= perCorner; i += 1) {
      const angle = start + ((i / perCorner) * Math.PI) / 2;
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  return clean(points);
}

function parsePrimitive(
  contour: AcrylicContour,
  segmentCount: number,
  curveSegments: number,
): Vec2d[][] {
  switch (contour.type) {
    case 'rect':
      if (
        !finite(contour.width) ||
        !finite(contour.height) ||
        contour.width <= 0 ||
        contour.height <= 0
      )
        throw new RangeError('Acrylic rectangle width and height must be positive');
      if (contour.radius !== undefined && (!finite(contour.radius) || contour.radius < 0))
        throw new RangeError('Acrylic rectangle radius must be non-negative');
      return [roundedRect(contour.width, contour.height, contour.radius ?? 0, segmentCount)];
    case 'circle': {
      if (!finite(contour.radius) || contour.radius <= 0)
        throw new RangeError('Acrylic circle radius must be positive');
      return [
        Array.from({ length: segmentCount }, (_, i) => {
          const angle = (i * Math.PI * 2) / segmentCount;
          return { x: contour.radius * Math.cos(angle), y: contour.radius * Math.sin(angle) };
        }),
      ];
    }
    case 'polygon':
      if (!Array.isArray(contour.points))
        throw new TypeError('Acrylic polygon points must be an array');
      return [clean(contour.points)];
    case 'svg':
      return Array.from(parseSvgPath(contour.path, curveSegments), (ring) => [...ring]);
    case 'compound': {
      if (!Array.isArray(contour.holes))
        throw new TypeError('Acrylic compound holes must be an array');
      const outer = parsePrimitive(contour.outer, segmentCount, curveSegments);
      if (outer.length !== 1)
        throw new RangeError('Acrylic compound outer must resolve to one ring');
      const holes = contour.holes.flatMap((hole) =>
        parsePrimitive(hole, segmentCount, curveSegments),
      );
      return [outer[0]!, ...holes];
    }
  }
}

function tokenize(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  let i = 0;
  while (i < path.length) {
    const char = path[i]!;
    if (/\s|,/.test(char)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      tokens.push(char);
      i += 1;
      continue;
    }
    const match = path.slice(i).match(/^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/);
    if (!match) throw new SyntaxError(`Invalid SVG token at offset ${i}`);
    tokens.push(Number(match[0]));
    i += match[0].length;
  }
  return tokens;
}
function quadratic(a: Vec2d, b: Vec2d, c: Vec2d, t: number): Vec2d {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    y: u * u * a.y + 2 * u * t * b.y + t * t * c.y,
  };
}
function cubic(a: Vec2d, b: Vec2d, c: Vec2d, d: Vec2d, t: number): Vec2d {
  const u = 1 - t;
  return {
    x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y,
  };
}

/** Parse the intentionally small deterministic SVG path subset. */
export function parseSvgPath(
  path: string,
  curveSegments = DEFAULT_CURVE_SEGMENTS,
): readonly Vec2d[][] {
  if (typeof path !== 'string' || path.trim() === '')
    throw new TypeError('Acrylic SVG path must be a non-empty string');
  if (!Number.isInteger(curveSegments) || curveSegments < 1)
    throw new RangeError('curveSegments must be a positive integer');
  const tokens = tokenize(path);
  let index = 0;
  let command = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let current: Vec2d[] | undefined;
  const rings: Vec2d[][] = [];
  const number = (): number => {
    const value = tokens[index++];
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new SyntaxError('SVG command requires a number');
    return value;
  };
  const relative = (): boolean => command === command.toLowerCase();
  const coord = (value: number, base: number): number => (relative() ? base + value : value);
  const finish = (): void => {
    if (current) {
      const ring = clean(current);
      if (ring.length) rings.push(ring);
    }
    current = undefined;
  };
  const push = (nx: number, ny: number): void => {
    if (!current) current = [];
    current.push({ x: nx, y: ny });
    x = nx;
    y = ny;
  };
  while (index < tokens.length) {
    if (typeof tokens[index] === 'string') command = tokens[index++] as string;
    if (!/[MmLlHhVvCcQqZz]/.test(command))
      throw new TypeError(`Unsupported SVG command ${command || String(tokens[index - 1])}`);
    const lower = command.toLowerCase();
    if (lower === 'z') {
      if (current) push(startX, startY);
      finish();
      command = '';
      continue;
    }
    if (lower === 'm') {
      const nx = coord(number(), x),
        ny = coord(number(), y);
      finish();
      current = [{ x: nx, y: ny }];
      x = nx;
      y = ny;
      startX = nx;
      startY = ny;
      command = relative() ? 'l' : 'L';
      continue;
    }
    if (lower === 'l') {
      push(coord(number(), x), coord(number(), y));
      continue;
    }
    if (lower === 'h') {
      push(coord(number(), x), y);
      continue;
    }
    if (lower === 'v') {
      push(x, coord(number(), y));
      continue;
    }
    const start = { x, y };
    if (lower === 'q') {
      const control = { x: coord(number(), x), y: coord(number(), y) };
      const end = { x: coord(number(), x), y: coord(number(), y) };
      for (let i = 1; i <= curveSegments; i += 1)
        push(
          ...(Object.values(quadratic(start, control, end, i / curveSegments)) as [number, number]),
        );
      continue;
    }
    const c1 = { x: coord(number(), x), y: coord(number(), y) };
    const c2 = { x: coord(number(), x), y: coord(number(), y) };
    const end = { x: coord(number(), x), y: coord(number(), y) };
    for (let i = 1; i <= curveSegments; i += 1)
      push(...(Object.values(cubic(start, c1, c2, end, i / curveSegments)) as [number, number]));
  }
  finish();
  if (rings.length === 0) throw new SyntaxError('SVG path contains no contour');
  return rings;
}

function onSegment(a: Vec2d, b: Vec2d, p: Vec2d): boolean {
  return (
    Math.abs(cross(a, b, p)) <= EPS &&
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}
function segmentsIntersect(a: Vec2d, b: Vec2d, c: Vec2d, d: Vec2d): boolean {
  const ab = cross(a, b, c),
    ab2 = cross(a, b, d),
    cd = cross(c, d, a),
    cd2 = cross(c, d, b);
  return (
    (((ab > EPS && ab2 < -EPS) || (ab < -EPS && ab2 > EPS)) &&
      ((cd > EPS && cd2 < -EPS) || (cd < -EPS && cd2 > EPS))) ||
    (Math.abs(ab) <= EPS && onSegment(a, b, c)) ||
    (Math.abs(ab2) <= EPS && onSegment(a, b, d)) ||
    (Math.abs(cd) <= EPS && onSegment(c, d, a)) ||
    (Math.abs(cd2) <= EPS && onSegment(c, d, b))
  );
}
function selfIntersects(ring: readonly Vec2d[]): boolean {
  for (let i = 0; i < ring.length; i += 1)
    for (let j = i + 1; j < ring.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
      if (
        segmentsIntersect(
          ring[i]!,
          ring[(i + 1) % ring.length]!,
          ring[j]!,
          ring[(j + 1) % ring.length]!,
        )
      )
        return true;
    }
  return false;
}
function pointInRing(point: Vec2d, ring: readonly Vec2d[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (onSegment(a, b, point)) return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function validateRings(rings: readonly Vec2d[][]): void {
  if (rings.length === 0) throw new RangeError('Acrylic contour contains no rings');
  for (const ring of rings) {
    if (ring.length < 3)
      throw new RangeError('Acrylic contour ring must have at least 3 points and non-zero area');
    if (selfIntersects(ring)) throw new RangeError('Acrylic contour ring must not self-intersect');
    if (Math.abs(signedArea(ring)) <= EPS)
      throw new RangeError('Acrylic contour ring must have at least 3 points and non-zero area');
  }
  const outer = rings[0]!;
  for (let i = 1; i < rings.length; i += 1) {
    const hole = rings[i]!;
    if (!pointInRing(hole[0]!, outer))
      throw new RangeError('Acrylic hole must be completely inside the outer contour');
    for (let j = i + 1; j < rings.length; j += 1)
      if (hole.some((point) => pointInRing(point, rings[j]!)) || ringsIntersect(hole, rings[j]!))
        throw new RangeError('Acrylic holes must not overlap');
    if (ringsIntersect(hole, outer))
      throw new RangeError('Acrylic hole must not intersect outer contour');
  }
}
function ringsIntersect(a: readonly Vec2d[], b: readonly Vec2d[]): boolean {
  for (let i = 0; i < a.length; i += 1)
    for (let j = 0; j < b.length; j += 1)
      if (segmentsIntersect(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!))
        return true;
  return false;
}

export function parseAcrylicContour(
  contour: AcrylicContour,
  options: AcrylicContourOptions = {},
): ParsedAcrylicContour {
  const segmentCount = ensureSegments(options.segmentCount, DEFAULT_SEGMENTS);
  const curveSegments = options.curveSegments ?? DEFAULT_CURVE_SEGMENTS;
  const raw = parsePrimitive(contour, segmentCount, curveSegments).map(clean);
  validateRings(raw);
  const rings: AcrylicRing[] = raw.map((ring, index) => {
    const wantPositive = index === 0;
    const positive = signedArea(ring) >= 0;
    return wantPositive === positive ? ring : [...ring].reverse();
  });
  const area = rings.reduce((sum, ring) => sum + signedArea(ring), 0);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const ring of rings)
    for (const point of ring) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  return { rings, area, bounds: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } };
}
export function areaOfRings(rings: readonly AcrylicRing[]): number {
  return rings.reduce((sum, ring) => sum + signedArea(ring), 0);
}
export function validateAcrylicDefinition(definition: AcrylicDefinition): void {
  if (!definition || typeof definition !== 'object')
    throw new TypeError('Acrylic definition is required');
  if (!finite(definition.thickness) || definition.thickness <= 0)
    throw new RangeError('Acrylic thickness must be a positive finite number in metres');
  parseAcrylicContour(definition.contour);
}
export const normaliseAcrylicContour = parseAcrylicContour;
export const normalizeAcrylicContour = parseAcrylicContour;
