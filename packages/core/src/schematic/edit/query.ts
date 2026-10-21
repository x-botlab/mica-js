import type { Point, Rect, SchematicDocument } from '../format/types';
import {
  GROUND_DEVICE,
  POWER_DEVICE,
  designatorOf,
  hasDesignator,
  isLabelDevice,
  isTextDevice,
  netNameOf,
  parseDeviceReference,
  symbolRole,
  textDeviceContent,
} from '../device/reference';
import type { DeviceSymbolProvider } from '../device/symbol';
import { pinSide, pinStubEnd, pinsBounds } from '../device/symbol';
import {
  DEFAULT_TOLERANCE,
  distanceToSegment,
  pointOnPolyline,
  pointsEqual,
} from '../geometry/point';
import {
  referencePosition,
  rotatePoint,
  symbolBounds,
  symbolPinPosition,
} from '../geometry/transform';

export interface HitTestOptions {
  readonly devices?: DeviceSymbolProvider;
  /** Coordinate comparison tolerance in page units; defaults to exact matching. */
  readonly tolerance?: number;
  /** Include symbol bodies in the hit search; defaults to true. */
  readonly includeSymbols?: boolean;
}

export type SchematicHit =
  | { readonly kind: 'reference'; readonly symbolId: string }
  | { readonly kind: 'junction'; readonly id: string }
  | { readonly kind: 'pin'; readonly symbolId: string; readonly pinId: string }
  | { readonly kind: 'wire'; readonly id: string; readonly segment: number }
  | { readonly kind: 'symbol'; readonly id: string };

/**
 * Returns the topmost element at `point`: reference labels, junctions, pins, wires, then
 * symbol bodies.
 */
export function hitTestSchematic(
  document: SchematicDocument,
  point: Point,
  options: HitTestOptions = {},
): SchematicHit | undefined {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const includeSymbols = options.includeSymbols ?? true;

  const reference = referenceHit(document, point, options, tolerance);
  if (reference !== undefined) {
    return reference;
  }

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
      const body = definition.bounds ??
        pinsBounds(definition.pins) ?? { x: -12, y: -12, width: 24, height: 24 };
      const pinIds = Object.keys(definition.pins).sort();
      for (const pinId of pinIds) {
        const anchor = definition.pins[pinId];
        if (anchor === undefined) {
          continue;
        }
        const end = symbolPinPosition(symbol, anchor);
        if (pointsEqual(end, point, tolerance)) {
          return { kind: 'pin', symbolId: symbol.id, pinId };
        }
        // The whole pin stub is grabbable, so clicking the drawn pin starts a wire at its end.
        const side = pinSide(anchor, body);
        if (side === undefined) {
          continue;
        }
        const start = symbolPinPosition(symbol, pinStubEnd(body, anchor, side));
        if (distanceToSegment(point, start, end) <= tolerance) {
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
        ? annotationBounds(symbol)
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

/** Approximate clickable box for symbols without device geometry (labels, text annotations). */
function annotationBounds(symbol: {
  readonly id: string;
  readonly device: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly net?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}): Rect {
  const device = symbol.device;
  if (device === POWER_DEVICE) {
    // Stem, bar and the label above them.
    return rotatedBounds(symbol, {
      x: -POWER_HALF_WIDTH,
      y: -POWER_HEIGHT,
      width: POWER_HALF_WIDTH * 2,
      height: POWER_HEIGHT + ANNOTATION_HEIGHT / 2,
    });
  }
  if (device === GROUND_DEVICE) {
    // Stem, the three bars and the label below them.
    return rotatedBounds(symbol, {
      x: -POWER_HALF_WIDTH,
      y: -ANNOTATION_HEIGHT / 2,
      width: POWER_HALF_WIDTH * 2,
      height: GROUND_HEIGHT,
    });
  }
  const content = isTextDevice(device)
    ? textDeviceContent(symbol)
    : isLabelDevice(device)
      ? (netNameOf(symbol) ?? '')
      : '';
  if (content.length === 0) {
    return { x: symbol.x, y: symbol.y, width: 0, height: 0 };
  }
  const height = ANNOTATION_HEIGHT;
  // Labels anchor at their connection point (left edge); text is drawn from its origin too.
  return rotatedBounds(symbol, {
    x: 0,
    y: -height / 2,
    width: content.length * ANNOTATION_CHAR_WIDTH,
    height,
  });
}

/** Axis-aligned box of a symbol-local rectangle after applying the symbol's rotation. */
function rotatedBounds(
  symbol: { readonly x: number; readonly y: number; readonly rotation: number },
  local: Rect,
): Rect {
  if (symbol.rotation % 360 === 0) {
    return {
      x: symbol.x + local.x,
      y: symbol.y + local.y,
      width: local.width,
      height: local.height,
    };
  }
  const corners = [
    { x: local.x, y: local.y },
    { x: local.x + local.width, y: local.y },
    { x: local.x, y: local.y + local.height },
    { x: local.x + local.width, y: local.y + local.height },
  ].map((corner) => {
    const rotated = rotatePoint(corner, symbol.rotation);
    return { x: symbol.x + rotated.x, y: symbol.y + rotated.y };
  });
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

const ANNOTATION_CHAR_WIDTH = 6;
const ANNOTATION_HEIGHT = 12;
/** Half width of the power/ground glyph box. */
const POWER_HALF_WIDTH = 10;
/** How far the power symbol (stem + bar + label) reaches above its anchor. */
const POWER_HEIGHT = 24;
/** How far the ground symbol (stem + bars + label) reaches below its anchor. */
const GROUND_HEIGHT = 30;

/** Hit box of a reference designator, positioned like the renderer draws it. */
function referenceHit(
  document: SchematicDocument,
  point: Point,
  options: HitTestOptions,
  tolerance: number,
): SchematicHit | undefined {
  const symbols = [...document.sheet.symbols]
    .filter((symbol) => hasDesignator(symbolRole(symbol.device)))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const symbol of symbols) {
    const reference = parseDeviceReference(symbol.device);
    const definition =
      reference === undefined ? undefined : options.devices?.getDeviceSymbol(reference);
    if (definition === undefined) {
      continue;
    }
    const designator = designatorOf(symbol) ?? symbol.id;
    const anchor = referencePosition(symbol, definition.bounds, symbol.reference);
    const width = designator.length * ANNOTATION_CHAR_WIDTH;
    const box: Rect = {
      x: anchor.x,
      y: anchor.y - ANNOTATION_HEIGHT,
      width,
      height: ANNOTATION_HEIGHT,
    };
    const inside =
      point.x >= box.x - tolerance &&
      point.x <= box.x + box.width + tolerance &&
      point.y >= box.y - tolerance &&
      point.y <= box.y + box.height + tolerance;
    if (inside) {
      return { kind: 'reference', symbolId: symbol.id };
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
