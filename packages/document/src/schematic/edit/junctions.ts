import type { SchematicDocument } from '../../format/types';
import type { Point } from '../../format/value';
import { pointOnPolyline } from '../geometry/point';

export interface JunctionReleaseOptions {
  readonly tolerance?: number;
}

export interface JunctionRelease {
  readonly id: string;
  /** Remaining participating wires; `undefined` means the junction has to be removed. */
  readonly wires: readonly string[] | undefined;
}

/**
 * Junctions that must let go of `wireId`: its new geometry no longer passes through them.
 *
 * A junction left with fewer than two wires is dropped instead of being kept dangling. Pure
 * geometry: the caller applies the resulting commands.
 */
export function planJunctionRelease(
  document: SchematicDocument,
  wireId: string,
  points: readonly Point[],
  options: JunctionReleaseOptions = {},
): readonly JunctionRelease[] {
  const tolerance = options.tolerance ?? 0;
  const releases: JunctionRelease[] = [];
  for (const junction of document.sheet.junctions) {
    if (!junction.wires.includes(wireId)) {
      continue;
    }
    if (pointOnPolyline(points, { x: junction.x, y: junction.y }, tolerance)) {
      continue;
    }
    const remaining = junction.wires.filter((id) => id !== wireId);
    releases.push({ id: junction.id, wires: remaining.length < 2 ? undefined : remaining });
  }
  return releases;
}

export interface JunctionJoin {
  readonly id: string;
  readonly wires: readonly string[];
}

/**
 * The junction sitting exactly at `point`, extended with `wireId`, so a wire that ends on an
 * existing junction actually joins it. `undefined` when there is nothing to join.
 */
export function joinJunctionAt(
  document: SchematicDocument,
  wireId: string,
  point: Point,
): JunctionJoin | undefined {
  const junction = document.sheet.junctions.find(
    (candidate) => candidate.x === point.x && candidate.y === point.y,
  );
  if (junction === undefined || junction.wires.includes(wireId)) {
    return undefined;
  }
  return { id: junction.id, wires: [...junction.wires, wireId] };
}
