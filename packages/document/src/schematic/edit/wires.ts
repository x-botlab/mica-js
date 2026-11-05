import { SchematicError } from '../../format/errors';
import { parseSchematic } from '../format/parse-schematic';
import type { SchematicDocument, SchematicJunction, SchematicWire } from '../../format/types';
import type { Point } from '../../format/value';
import { DEFAULT_TOLERANCE, pointOnPolyline, pointsEqual } from '../geometry/point';
import { defaultElementIdFactory, type ElementIdFactory } from './ids';

export interface WireEditOptions {
  readonly tolerance?: number;
  readonly createId?: ElementIdFactory;
}

export interface SplitWireResult {
  readonly document: SchematicDocument;
  /** Wire that keeps the original id (the part before `point`). */
  readonly firstWireId: string;
  readonly secondWireId: string;
}

export interface MergeWiresResult {
  readonly document: SchematicDocument;
  /** Wire that kept its id and absorbed the other one. */
  readonly wireId: string;
  readonly removedWireId: string;
  readonly removedJunctionId: string;
}

/**
 * Splits `wireId` at `point`, which must lie strictly inside the polyline.
 * Junctions that only touch the second half are re-pointed to the new wire.
 *
 * @throws {SchematicError} when the wire is unknown or `point` is not an interior point.
 */
export function splitWireAt(
  document: SchematicDocument,
  wireId: string,
  point: Point,
  options: WireEditOptions = {},
): SplitWireResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const wire = document.sheet.wires.find((candidate) => candidate.id === wireId);
  if (wire === undefined) {
    throw new SchematicError([
      {
        severity: 'error',
        code: 'edit/unknown-entity',
        message: `Unknown wire "${wireId}".`,
        entity: { kind: 'wire', id: wireId },
      },
    ]);
  }

  const split = splitPoints(wire.points, point, tolerance);
  if (split === undefined) {
    throw new SchematicError([
      {
        severity: 'error',
        code: 'wire/invalid-points',
        message: `Point (${point.x}, ${point.y}) is not an interior point of wire "${wireId}".`,
        entity: { kind: 'wire', id: wireId },
      },
    ]);
  }

  const firstWireId = wireId;
  const secondWireId =
    options.createId?.('wire', document) ?? defaultElementIdFactory('wire', document);
  if (secondWireId === firstWireId) {
    throw new SchematicError([
      {
        severity: 'error',
        code: 'edit/invalid-command',
        message: `Generated wire id "${secondWireId}" collides with the split wire.`,
        entity: { kind: 'wire', id: wireId },
      },
    ]);
  }

  const [firstPoints, secondPoints] = split;
  const wires: SchematicWire[] = [];
  for (const candidate of document.sheet.wires) {
    if (candidate.id !== wireId) {
      wires.push(candidate);
      continue;
    }
    wires.push({ id: firstWireId, points: firstPoints });
    wires.push({ id: secondWireId, points: secondPoints });
  }

  const junctions = document.sheet.junctions.map((junction) =>
    remapJunction(
      junction,
      wireId,
      firstWireId,
      secondWireId,
      firstPoints,
      secondPoints,
      point,
      tolerance,
    ),
  );

  return {
    document: validate({ ...document, sheet: { ...document.sheet, wires, junctions } }),
    firstWireId,
    secondWireId,
  };
}

/**
 * Merges the two collinear wires meeting at `junctionId` into one wire and removes the junction.
 * Returns `undefined` when the junction does not describe such a splice.
 *
 * @throws {SchematicError} when the junction is unknown.
 */
export function mergeWiresAtJunction(
  document: SchematicDocument,
  junctionId: string,
  options: WireEditOptions = {},
): MergeWiresResult | undefined {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const junction = document.sheet.junctions.find((candidate) => candidate.id === junctionId);
  if (junction === undefined) {
    throw new SchematicError([
      {
        severity: 'error',
        code: 'edit/unknown-entity',
        message: `Unknown junction "${junctionId}".`,
        entity: { kind: 'junction', id: junctionId },
      },
    ]);
  }
  if (junction.wires.length !== 2) {
    return undefined;
  }

  const [firstId, secondId] = junction.wires as [string, string];
  const first = document.sheet.wires.find((wire) => wire.id === firstId);
  const second = document.sheet.wires.find((wire) => wire.id === secondId);
  if (first === undefined || second === undefined) {
    return undefined;
  }

  const merged = mergePoints(first.points, second.points, junction, tolerance);
  if (merged === undefined) {
    return undefined;
  }

  const wires: SchematicWire[] = [];
  for (const candidate of document.sheet.wires) {
    if (candidate.id === secondId) {
      continue;
    }
    wires.push(candidate.id === firstId ? { id: firstId, points: merged } : candidate);
  }

  const junctions = document.sheet.junctions
    .filter((candidate) => candidate.id !== junctionId)
    .map((candidate) =>
      candidate.wires.includes(secondId)
        ? { ...candidate, wires: candidate.wires.map((id) => (id === secondId ? firstId : id)) }
        : candidate,
    );

  return {
    document: validate({ ...document, sheet: { ...document.sheet, wires, junctions } }),
    wireId: firstId,
    removedWireId: secondId,
    removedJunctionId: junctionId,
  };
}

function validate(document: SchematicDocument): SchematicDocument {
  return parseSchematic(document);
}

function splitPoints(
  points: readonly Point[],
  point: Point,
  tolerance: number,
): readonly [readonly Point[], readonly Point[]] | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  if (pointsEqual(first, point, tolerance) || pointsEqual(last, point, tolerance)) {
    return undefined;
  }
  if (!pointOnPolyline(points, point, tolerance)) {
    return undefined;
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (!pointOnPolyline([previous, current], point, tolerance)) {
      continue;
    }
    const firstPoints = [...points.slice(0, index), { x: point.x, y: point.y }];
    const secondPoints = [{ x: point.x, y: point.y }, ...points.slice(index)];
    return [firstPoints, secondPoints];
  }
  return undefined;
}

function remapJunction(
  junction: SchematicJunction,
  wireId: string,
  firstWireId: string,
  secondWireId: string,
  firstPoints: readonly Point[],
  secondPoints: readonly Point[],
  splitPoint: Point,
  tolerance: number,
): SchematicJunction {
  if (!junction.wires.includes(wireId)) {
    return junction;
  }
  const point = { x: junction.x, y: junction.y };
  if (pointsEqual(point, splitPoint, tolerance)) {
    const others = junction.wires.filter((id) => id !== wireId);
    return { ...junction, wires: [firstWireId, secondWireId, ...others] };
  }
  const onFirst = pointOnPolyline(firstPoints, point, tolerance);
  const onSecond = pointOnPolyline(secondPoints, point, tolerance);
  if (onFirst && !onSecond) {
    return junction;
  }
  if (onSecond && !onFirst) {
    return { ...junction, wires: junction.wires.map((id) => (id === wireId ? secondWireId : id)) };
  }
  return junction;
}

function mergePoints(
  first: readonly Point[],
  second: readonly Point[],
  junction: SchematicJunction,
  tolerance: number,
): readonly Point[] | undefined {
  const at = { x: junction.x, y: junction.y };
  const firstStart = first[0];
  const firstEnd = first[first.length - 1];
  const secondStart = second[0];
  const secondEnd = second[second.length - 1];
  if (
    firstStart === undefined ||
    firstEnd === undefined ||
    secondStart === undefined ||
    secondEnd === undefined
  ) {
    return undefined;
  }

  const firstStartsAt = pointsEqual(firstStart, at, tolerance);
  const firstEndsAt = pointsEqual(firstEnd, at, tolerance);
  const secondStartsAt = pointsEqual(secondStart, at, tolerance);
  const secondEndsAt = pointsEqual(secondEnd, at, tolerance);

  let head: readonly Point[] | undefined;
  let tail: readonly Point[] | undefined;
  if (firstEndsAt && secondStartsAt) {
    head = first;
    tail = second;
  } else if (secondEndsAt && firstStartsAt) {
    head = second;
    tail = first;
  } else if (firstEndsAt && secondEndsAt) {
    head = first;
    tail = [...second].reverse();
  } else if (firstStartsAt && secondStartsAt) {
    head = [...first].reverse();
    tail = second;
  }
  if (head === undefined || tail === undefined || !isContinuous(head, tail)) {
    return undefined;
  }
  return [...head, ...tail.slice(1)];
}

/** True when the last segment of `a` and the first segment of `b` are collinear. */
function isContinuous(a: readonly Point[], b: readonly Point[]): boolean {
  const a1 = a[a.length - 2];
  const a2 = a[a.length - 1];
  const b1 = b[0];
  const b2 = b[1];
  if (a1 === undefined || a2 === undefined || b1 === undefined || b2 === undefined) {
    return false;
  }
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  const cross = ax * by - ay * bx;
  const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (scale === 0) {
    return false;
  }
  return Math.abs(cross) / scale <= 1e-9 && ax * bx + ay * by > 0;
}
