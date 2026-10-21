import {
  SchematicError,
  joinJunctionAt,
  planJunctionRelease,
  planSegmentDrag,
  pointOnPolyline,
  samePoint,
  splitWireAt,
  type Point,
} from '@mica-js/core/schematic';
import type { EditorSession } from './session';

/**
 * Appends a wire. Endpoints that land inside another wire split it and create a junction, and
 * endpoints that land on an existing junction join it, so the new wire is electrically connected.
 */
export function addWire(session: EditorSession, points: readonly Point[]): void {
  if (points.length < 2) {
    session.reject(
      new SchematicError([
        { severity: 'error', code: 'wire/invalid-points', message: 'A wire needs two points.' },
      ]),
    );
  }
  session.mutate(
    () => {
      const id = session.createId('wire', session.document);
      session.editor.dispatch({ type: 'add-wire', id, points });
      for (const point of [points[0], points[points.length - 1]]) {
        if (point === undefined) {
          continue;
        }
        const host = hitTestWire(session, point, id);
        if (host !== undefined) {
          splitInto(session, id, host.wireId, point);
          continue;
        }
        const join = joinJunctionAt(session.document, id, point);
        if (join !== undefined) {
          session.editor.dispatch({ type: 'update-junction', id: join.id, wires: join.wires });
        }
      }
    },
    { reconcile: false },
  );
}

/** Splits `wireId` at `point` and creates a junction there. */
export function connectWireAt(
  session: EditorSession,
  wireId: string,
  point: Point,
  otherWireId?: string,
): string {
  let junctionId = '';
  session.mutate(
    () => {
      junctionId = splitInto(session, otherWireId, wireId, point, { strict: true });
    },
    { reconcile: false },
  );
  return junctionId;
}

/**
 * Slides one wire segment by `delta` along its normal. The whole run of segments parallel to it
 * moves along; junctions left behind on the old geometry let go of this wire.
 */
export function moveWireSegment(
  session: EditorSession,
  wireId: string,
  segment: number,
  delta: Point,
): void {
  const points = previewWireSegment(session, wireId, segment, delta);
  if (points === undefined) {
    return;
  }
  session.mutate(() => {
    for (const release of planJunctionRelease(session.document, wireId, points)) {
      session.editor.dispatch(
        release.wires === undefined
          ? { type: 'remove-junction', id: release.id }
          : { type: 'update-junction', id: release.id, wires: release.wires },
      );
    }
    session.editor.dispatch({ type: 'set-wire-points', id: wireId, points });
  });
}

/** Wire points a segment drag would produce; the renderer previews them before the commit. */
export function previewWireSegment(
  session: EditorSession,
  wireId: string,
  segment: number,
  delta: Point,
): readonly Point[] | undefined {
  return planSegmentDrag(session.document, wireId, segment, delta, session.options);
}

/** Removes a wire while keeping its junctions for the merge pass to collapse. */
export function removeWire(session: EditorSession, wireId: string): void {
  const attached = session.document.sheet.junctions.filter((junction) =>
    junction.wires.includes(wireId),
  );
  for (const junction of attached) {
    const remaining = junction.wires.filter((id) => id !== wireId);
    if (remaining.length >= 2) {
      session.editor.dispatch({ type: 'update-junction', id: junction.id, wires: remaining });
    } else {
      session.editor.dispatch({ type: 'remove-junction', id: junction.id });
    }
  }
  session.editor.dispatch({ type: 'remove-wire', id: wireId });
}

/** Wire whose interior (not its ends) passes through `point`, excluding `excludeWireId`. */
function hitTestWire(
  session: EditorSession,
  point: Point,
  excludeWireId: string,
): { wireId: string } | undefined {
  // Scanned directly instead of through `hitTest`: the point sits on both the new wire and the
  // host, and which one a plain hit reports depends on element order.
  for (const wire of session.document.sheet.wires) {
    if (wire.id === excludeWireId || !pointOnPolyline(wire.points, point, session.tolerance ?? 0)) {
      continue;
    }
    const [first, last] = [wire.points[0], wire.points[wire.points.length - 1]];
    if (first === undefined || last === undefined) {
      continue;
    }
    if (samePoint(first, point) || samePoint(last, point)) {
      continue;
    }
    return { wireId: wire.id };
  }
  return undefined;
}

/** Splits `hostWireId` at `point` and joins `newWireId` to the junction it creates. */
function splitInto(
  session: EditorSession,
  newWireId: string | undefined,
  hostWireId: string,
  point: Point,
  options: { strict?: boolean } = {},
): string {
  const document = session.document;
  if (!options.strict) {
    const wire = session.findWire(hostWireId);
    const [first, last] = [wire?.points[0], wire?.points[wire.points.length - 1]];
    if (
      wire === undefined ||
      first === undefined ||
      last === undefined ||
      samePoint(first, point) ||
      samePoint(last, point)
    ) {
      return '';
    }
  }
  const split = splitWireAt(document, hostWireId, point, {
    ...(session.tolerance === undefined ? {} : { tolerance: session.tolerance }),
    createId: session.createId,
  });
  const junctionId = session.createId('junction', split.document);
  const wires = [split.firstWireId, split.secondWireId];
  if (newWireId !== undefined && newWireId.length > 0 && !wires.includes(newWireId)) {
    wires.push(newWireId);
  }
  const junctions = [
    ...split.document.sheet.junctions,
    { id: junctionId, x: point.x, y: point.y, wires },
  ];
  session.editor.replace({
    ...split.document,
    sheet: { ...split.document.sheet, junctions },
  });
  return junctionId;
}
