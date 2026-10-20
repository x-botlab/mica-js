import type { Point, SchematicDocument } from '../format/types';
import { isLabelDevice, parseDeviceReference } from '../device/reference';
import type { DeviceSymbolProvider } from '../device/symbol';
import {
  DEFAULT_TOLERANCE,
  distanceToSegment,
  pointOnPolyline,
  pointsEqual,
} from '../geometry/point';
import { symbolBounds, symbolPinPosition } from '../geometry/transform';

export interface HitTestOptions {
  readonly devices?: DeviceSymbolProvider;
  /** Coordinate comparison tolerance in page units; defaults to exact matching. */
  readonly tolerance?: number;
  /** Include symbol bodies in the hit search; defaults to true. */
  readonly includeSymbols?: boolean;
}

export type SchematicHit =
  | { readonly kind: 'junction'; readonly id: string }
  | { readonly kind: 'pin'; readonly symbolId: string; readonly pinId: string }
  | { readonly kind: 'wire'; readonly id: string; readonly segment: number }
  | { readonly kind: 'symbol'; readonly id: string };

/**
 * Returns the topmost element at `point`, preferring junctions, then pins, wires and symbols.
 */
export function hitTestSchematic(
  document: SchematicDocument,
  point: Point,
  options: HitTestOptions = {},
): SchematicHit | undefined {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const includeSymbols = options.includeSymbols ?? true;

  const junctions = [...document.sheet.junctions].sort((a, b) => a.id.localeCompare(b.id));
  for (const junction of junctions) {
    if (pointsEqual({ x: junction.x, y: junction.y }, point, tolerance)) {
      return { kind: 'junction', id: junction.id };
    }
  }

  if (options.devices !== undefined) {
    const symbols = [...document.sheet.symbols]
      .filter((symbol) => !isLabelDevice(symbol.device))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const symbol of symbols) {
      const reference = parseDeviceReference(symbol.device);
      const definition =
        reference === undefined ? undefined : options.devices.getDeviceSymbol(reference);
      if (definition === undefined) {
        continue;
      }
      const pinIds = Object.keys(definition.pins).sort();
      for (const pinId of pinIds) {
        const anchor = definition.pins[pinId];
        if (anchor === undefined) {
          continue;
        }
        if (pointsEqual(symbolPinPosition(symbol, anchor), point, tolerance)) {
          return { kind: 'pin', symbolId: symbol.id, pinId };
        }
      }
    }
  }

  const wires = [...document.sheet.wires].sort((a, b) => a.id.localeCompare(b.id));
  for (const wire of wires) {
    for (let index = 1; index < wire.points.length; index += 1) {
      const previous = wire.points[index - 1];
      const current = wire.points[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        distanceToSegment(point, previous, current) <= tolerance
      ) {
        return { kind: 'wire', id: wire.id, segment: index - 1 };
      }
    }
  }

  if (!includeSymbols) {
    return undefined;
  }

  const symbols = [...document.sheet.symbols].sort((a, b) => a.id.localeCompare(b.id));
  for (const symbol of symbols) {
    const reference = parseDeviceReference(symbol.device);
    const definition =
      reference === undefined ? undefined : options.devices?.getDeviceSymbol(reference);
    const bounds =
      definition === undefined
        ? { x: symbol.x, y: symbol.y, width: 0, height: 0 }
        : symbolBounds(symbol, definition.bounds, definition.pins);
    if (bounds === undefined) {
      continue;
    }
    const inside =
      point.x >= bounds.x - tolerance &&
      point.x <= bounds.x + bounds.width + tolerance &&
      point.y >= bounds.y - tolerance &&
      point.y <= bounds.y + bounds.height + tolerance;
    if (inside) {
      return { kind: 'symbol', id: symbol.id };
    }
  }

  return undefined;
}

export interface JunctionCandidate {
  readonly point: Point;
  readonly wireIds: readonly string[];
}

export interface JunctionCandidateOptions {
  readonly tolerance?: number;
}

/**
 * Finds positions where wires touch or cross without an explicit junction (#6 requires junctions
 * to be created by the user). Existing junctions are excluded.
 */
export function findJunctionCandidates(
  document: SchematicDocument,
  options: JunctionCandidateOptions = {},
): readonly JunctionCandidate[] {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const wires = [...document.sheet.wires].sort((a, b) => a.id.localeCompare(b.id));
  const existing = document.sheet.junctions;
  const candidates: { point: Point; wireIds: Set<string> }[] = [];

  const add = (point: Point, wireId: string): void => {
    // Points within tolerance describe the same junction handle, so they are merged.
    const entry = candidates.find((candidate) => pointsEqual(candidate.point, point, tolerance));
    if (entry === undefined) {
      candidates.push({ point: { x: point.x, y: point.y }, wireIds: new Set([wireId]) });
      return;
    }
    entry.wireIds.add(wireId);
  };

  for (let left = 0; left < wires.length; left += 1) {
    const first = wires[left];
    if (first === undefined) {
      continue;
    }
    for (let right = left + 1; right < wires.length; right += 1) {
      const second = wires[right];
      if (second === undefined) {
        continue;
      }
      const points: Point[] = [...intersections(first.points, second.points, tolerance)];
      const firstPoints = [...first.points];
      const secondPoints = [...second.points];
      for (const point of firstPoints) {
        if (pointOnPolyline(secondPoints, point, tolerance)) {
          points.push(point);
        }
      }
      for (const point of secondPoints) {
        if (pointOnPolyline(firstPoints, point, tolerance)) {
          points.push(point);
        }
      }
      for (const point of points) {
        add(point, first.id);
        add(point, second.id);
      }
    }
  }

  const result: JunctionCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.wireIds.size < 2) {
      continue;
    }
    const wireIds = [...candidate.wireIds].sort();
    const covered = existing.some(
      (junction) =>
        pointsEqual({ x: junction.x, y: junction.y }, candidate.point, tolerance) &&
        wireIds.every((wireId) => junction.wires.includes(wireId)),
    );
    if (!covered) {
      result.push({ point: candidate.point, wireIds });
    }
  }

  return result.sort(
    (a, b) =>
      a.point.x - b.point.x ||
      a.point.y - b.point.y ||
      a.wireIds.join(',').localeCompare(b.wireIds.join(',')),
  );
}

/** Segment–segment intersection points in the closed-segment sense, within `tolerance`. */
function* intersections(
  first: readonly Point[],
  second: readonly Point[],
  tolerance: number,
): Generator<Point> {
  for (let a = 1; a < first.length; a += 1) {
    const a1 = first[a - 1];
    const a2 = first[a];
    if (a1 === undefined || a2 === undefined) {
      continue;
    }
    for (let b = 1; b < second.length; b += 1) {
      const b1 = second[b - 1];
      const b2 = second[b];
      if (b1 === undefined || b2 === undefined) {
        continue;
      }
      const point = segmentIntersection(a1, a2, b1, b2, tolerance);
      if (point !== undefined) {
        yield point;
      }
    }
  }
}

function segmentIntersection(
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
  tolerance: number,
): Point | undefined {
  const r = { x: a2.x - a1.x, y: a2.y - a1.y };
  const s = { x: b2.x - b1.x, y: b2.y - b1.y };
  const denominator = r.x * s.y - r.y * s.x;
  const qp = { x: b1.x - a1.x, y: b1.y - a1.y };
  if (Math.abs(denominator) < Number.EPSILON) {
    // Parallel or collinear: overlap points are covered by the endpoint checks in the caller.
    return undefined;
  }
  const t = (qp.x * s.y - qp.y * s.x) / denominator;
  const u = (qp.x * r.y - qp.y * r.x) / denominator;
  const slackT = tolerance === 0 ? 0 : tolerance / Math.hypot(r.x, r.y);
  const slackU = tolerance === 0 ? 0 : tolerance / Math.hypot(s.x, s.y);
  if (t < -slackT || t > 1 + slackT || u < -slackU || u > 1 + slackU) {
    return undefined;
  }
  return { x: a1.x + t * r.x, y: a1.y + t * r.y };
}
