/**
 * Orthogonal wire routing and anchor materialization of the fused workbench (RFC 0024).
 *
 * A fused wire persists only its intermediate bends; the full polyline is the from anchor, the
 * bends and the to anchor. Device anchors move with rotation, scaling and placement, so every
 * mutation that can move an anchor has to rebuild the bends until each leg is horizontal or
 * vertical — the same rule the separate schematic editor applies.
 *
 * The rules are shared with that editor instead of growing a second algorithm:
 * `orthogonalWaypoints` picks the elbow with the long axis first, `extendWirePath` folds retraced
 * collinear legs, and the endpoint absorption below is the same "shift the neighbour, stop at the
 * next corner" pass, bounded so it can never move the far anchor of a wire.
 */
import type {
  ConnectionNode,
  ConnectionWire,
  Endpoint,
  FusedDocument,
  Point2D,
} from '@mica-js/document/fused';
import { projectOnSegment } from '@mica-js/document/schematic';
import { extendWirePath, orthogonalWaypoints } from '../schematic/editor/snapping/wire';
import { localToScene, type ICanvasDevice } from './canvas/geometry';
import { planPolylineSegmentDrag } from '../schematic/editing/segment-drag';
import { FusedSessionError } from './document/errors';
import { addNode, addWire, sameEndpoint, type IdFactory } from './document/edits';

/** Verified device geometry keyed by full device id; prepared devices and canvas devices match. */
export type WiringDevices = ReadonlyMap<string, ICanvasDevice>;

/** Explicit wire membership is based on endpoint identity, never coordinate overlap. */
export function hasWireConnection(document: FusedDocument, endpoint: Endpoint): boolean {
  return document.wires.some(
    (wire) => sameEndpoint(wire.from, endpoint) || sameEndpoint(wire.to, endpoint),
  );
}

/** Distance under which a tapped point counts as lying on a wire, in scene millimetres. */
const TAP_EPSILON = 1e-6;

/**
 * Turns any point sequence into one orthogonal polyline.
 *
 * Consecutive points that are not aligned receive the elbow of `orthogonalWaypoints` (long axis
 * first), and retraced collinear legs collapse the way the schematic wire tool collapses them.
 *
 * ```ts
 * orthogonalPath([{ x: 0, y: 0 }, { x: 10, y: 6 }]);
 * // [{ 0, 0 }, { 10, 0 }, { 10, 6 }]
 * ```
 */
export function orthogonalPath(points: readonly Point2D[]): readonly Point2D[] {
  const [first, ...rest] = points;
  if (first === undefined) {
    return [];
  }
  let path: Point2D[] = [{ x: first.x, y: first.y }];
  for (const point of rest) {
    path = extendWirePath(path, { x: point.x, y: point.y }, undefined);
  }
  return path;
}

/** Whether every leg of the polyline is horizontal or vertical. */
export function isOrthogonalPolyline(points: readonly Point2D[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (previous === undefined || point === undefined) {
      return false;
    }
    if (previous.x !== point.x && previous.y !== point.y) {
      return false;
    }
  }
  return true;
}

/** Scene position of one connection endpoint, or `undefined` when it cannot be resolved. */
export function endpointPoint(
  document: FusedDocument,
  devices: WiringDevices,
  endpoint: Endpoint,
): Point2D | undefined {
  if (endpoint.kind === 'node') {
    const node = document.nodes.find((candidate) => candidate.id === endpoint.node);
    return node === undefined ? undefined : { x: node.x, y: node.y };
  }
  const instance = document.instances.find((candidate) => candidate.id === endpoint.instance);
  if (instance === undefined) {
    return undefined;
  }
  const geometry = devices.get(instance.device)?.geometry;
  const pin = geometry?.pins[endpoint.pin];
  if (geometry === undefined || pin === undefined) {
    return undefined;
  }
  return localToScene(instance, geometry, pin.position);
}

/** Full polyline of one wire: the from anchor, the stored bends and the to anchor. */
export function wirePolyline(
  document: FusedDocument,
  devices: WiringDevices,
  wire: ConnectionWire,
): readonly Point2D[] | undefined {
  const from = endpointPoint(document, devices, wire.from);
  const to = endpointPoint(document, devices, wire.to);
  if (from === undefined || to === undefined) {
    return undefined;
  }
  return [from, ...wire.bends, to];
}

/** Slides one wire segment while retaining both explicit electrical endpoints. */
export function moveWireSegment(
  document: FusedDocument,
  devices: WiringDevices,
  wireId: string,
  segment: number,
  delta: Point2D,
): FusedDocument {
  const wire = document.wires.find((value) => value.id === wireId);
  const points = wire === undefined ? undefined : wirePolyline(document, devices, wire);
  const start = points?.[segment];
  const end = points?.[segment + 1];
  if (
    points === undefined ||
    !Number.isInteger(segment) ||
    start === undefined ||
    end === undefined ||
    !Number.isFinite(delta.x) ||
    !Number.isFinite(delta.y)
  )
    throw new FusedSessionError('edit/invalid-request', 'Invalid wire segment drag');
  const normal = start.y === end.y ? { x: 0, y: delta.y } : { x: delta.x, y: 0 };
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const moved = planPolylineSegmentDrag(
    points,
    segment,
    normal,
    (point) =>
      (point.x === first.x && point.y === first.y) || (point.x === last.x && point.y === last.y),
  );
  if (moved === undefined) return document;
  const bends = orthogonalPath(moved).slice(1, -1);
  return {
    ...document,
    wires: document.wires.map((value) => (value.id === wireId ? { ...value, bends } : value)),
  };
}

/** A dragged pin-attached terminal gains its own anchor and an explicit connecting wire. */
export function moveReference(
  document: FusedDocument,
  devices: WiringDevices,
  referenceId: string,
  position: Point2D,
  createId: IdFactory,
): FusedDocument {
  const reference = document.references.find((value) => value.id === referenceId);
  if (reference === undefined || !Number.isFinite(position.x) || !Number.isFinite(position.y))
    throw new FusedSessionError('edit/invalid-request', 'Invalid terminal drag');
  const origin = endpointPoint(document, devices, reference.target);
  if (origin === undefined)
    throw new FusedSessionError('edit/invalid-request', 'Unknown terminal anchor');
  if (origin.x === position.x && origin.y === position.y) return document;
  const target = reference.target;
  if (target.kind === 'node') {
    const node = document.nodes.find((value) => value.id === target.node);
    const shared =
      node?.kind === 'junction' ||
      document.references.some(
        (value) =>
          value.id !== referenceId &&
          value.target.kind === 'node' &&
          value.target.node === target.node,
      ) ||
      document.labels.some(
        (value) => value.target.kind === 'node' && value.target.node === target.node,
      ) ||
      document.wires.filter(
        (value) =>
          (value.from.kind === 'node' && value.from.node === target.node) ||
          (value.to.kind === 'node' && value.to.node === target.node),
      ).length > 1;
    if (!shared) {
      return routeDocumentWires(
        {
          ...document,
          nodes: document.nodes.map((value) =>
            value.id === target.node ? { ...value, ...position } : value,
          ),
        },
        devices,
        document,
      );
    }
  }
  const added = addNode(document, position, 'free', createId);
  const endpoint: Endpoint = { kind: 'node', node: added.nodeId };
  const moved: FusedDocument = {
    ...added.document,
    references: added.document.references.map((value) =>
      value.id === referenceId ? { ...value, target: endpoint } : value,
    ),
  };
  return addWire(
    moved,
    reference.target,
    endpoint,
    routeWireBends(moved, devices, reference.target, endpoint, []),
    createId,
  ).document;
}

/**
 * The free node a standalone net label owns, when dragging the label should carry its anchor.
 *
 * A label dropped on empty canvas owns the node it created: nothing else names that node, it is
 * not a branch and at most one wire hangs on it. A label naming a pin, a junction or a shared node
 * only owns its text, so its name may sit anywhere without dragging the connection with it.
 */
export function labelAnchorNode(document: FusedDocument, labelId: string): string | undefined {
  const label = document.labels.find((value) => value.id === labelId);
  const target = label?.target;
  if (target?.kind !== 'node') return undefined;
  const node = document.nodes.find((value) => value.id === target.node);
  if (node === undefined || node.kind === 'junction') return undefined;
  const shared =
    document.labels.some(
      (value) =>
        value.id !== labelId && value.target.kind === 'node' && value.target.node === node.id,
    ) ||
    document.references.some(
      (value) => value.target.kind === 'node' && value.target.node === node.id,
    ) ||
    document.wires.filter(
      (value) =>
        (value.from.kind === 'node' && value.from.node === node.id) ||
        (value.to.kind === 'node' && value.to.node === node.id),
    ).length > 1;
  return shared ? undefined : node.id;
}

/** Moves a standalone net label as one object: the connection point and the name travel together. */
export function moveLabel(
  document: FusedDocument,
  devices: WiringDevices,
  labelId: string,
  position: Point2D,
): FusedDocument {
  const nodeId = labelAnchorNode(document, labelId);
  if (nodeId === undefined || !Number.isFinite(position.x) || !Number.isFinite(position.y))
    throw new FusedSessionError('edit/invalid-request', 'Invalid net label drag');
  const node = document.nodes.find((value) => value.id === nodeId);
  if (node === undefined)
    throw new FusedSessionError('edit/invalid-request', 'Unknown net label anchor');
  if (node.x === position.x && node.y === position.y) return document;
  return routeDocumentWires(
    {
      ...document,
      nodes: document.nodes.map((value) =>
        value.id === nodeId ? { ...value, x: position.x, y: position.y } : value,
      ),
    },
    devices,
    document,
  );
}

/**
 * Bends for a new wire from `from` to `to` through the requested waypoints.
 *
 * The waypoints stay in the order the caller picked them; only the legs between them are
 * orthogonalized.
 */
export function routeWireBends(
  document: FusedDocument,
  devices: WiringDevices,
  from: Endpoint,
  to: Endpoint,
  bends: readonly Point2D[],
): readonly Point2D[] {
  const start = endpointPoint(document, devices, from);
  const end = endpointPoint(document, devices, to);
  if (start === undefined || end === undefined) {
    return bends;
  }
  const path = orthogonalPath([start, ...bends, end]);
  return path.length < 2 ? [] : path.slice(1, -1);
}

/**
 * Rebuilds the bends of every wire whose legs are no longer orthogonal.
 *
 * `previous` is the document before the mutation. With it, endpoints that moved are absorbed the
 * way a symbol drag absorbs them: neighbouring bends shift, a rigid move translates the whole run
 * and the far anchor never moves. Without it (or for a wire the mutation also edited) the affected
 * wire is routed as one canonical orthogonal path.
 *
 * Wires that are already orthogonal are returned untouched, so existing geometry is preserved.
 */
export function routeDocumentWires(
  document: FusedDocument,
  devices: WiringDevices,
  previous?: FusedDocument,
): FusedDocument {
  if (document.wires.length === 0) {
    return document;
  }
  const previousWires = new Map((previous?.wires ?? []).map((wire) => [wire.id, wire]));
  let changed = false;
  const wires = document.wires.map((wire) => {
    const line = wirePolyline(document, devices, wire);
    if (line === undefined || isOrthogonalPolyline(line)) {
      return wire;
    }
    const rerouted = rerouteWire(wire, line, devices, previous, previousWires.get(wire.id));
    const bends = rerouted.slice(1, -1);
    if (samePoints(bends, wire.bends)) {
      return wire;
    }
    changed = true;
    return { ...wire, bends };
  });
  return changed ? { ...document, wires } : document;
}

/**
 * Resolves one placement anchor to a real endpoint without mutating anything.
 *
 * - An existing {@link Endpoint} passes through unchanged.
 * - A point on a pin or on a connection node resolves to that endpoint.
 * - A point on a wire splits every host wire there and returns one shared junction node, so the
 *   caller's next wire, label or reference is electrically connected.
 * - Any other point becomes a free node.
 *
 * The function is pure: the input document is never changed, so an abandoned gesture persists
 * nothing and an Escape leaves no orphan node or wire behind.
 */
export function materializeAnchor(
  document: FusedDocument,
  anchor: Endpoint | Point2D,
  devices: WiringDevices,
  createId: () => string,
): { readonly document: FusedDocument; readonly endpoint: Endpoint } {
  if (isEndpoint(anchor)) {
    return { document, endpoint: anchor };
  }
  const point = readPoint(anchor);

  const pin = pinAt(document, devices, point);
  if (pin !== undefined) {
    return { document, endpoint: pin };
  }
  const node = document.nodes.find((candidate) => samePoint(candidate, point));
  if (node !== undefined) {
    return { document, endpoint: { kind: 'node', node: node.id } };
  }

  const candidates = document.wires.flatMap((wire) => {
    const line = wirePolyline(document, devices, wire);
    if (line === undefined) {
      return [];
    }
    const split = locateOnPolyline(line, point);
    return split === undefined ? [] : [{ wire, split, line }];
  });
  const origin = candidates[0]?.split.point;
  // Only wires that meet at the very same point share the junction; a near miss stays untouched.
  const hosts =
    origin === undefined
      ? []
      : candidates.filter((candidate) => samePoint(candidate.split.point, origin));
  const taken = takenIds(document);
  if (hosts.length === 0) {
    const nodeId = freshId(taken, createId);
    const free: ConnectionNode = { id: nodeId, kind: 'free', x: point.x, y: point.y };
    return {
      document: { ...document, nodes: [...document.nodes, free] },
      endpoint: { kind: 'node', node: nodeId },
    };
  }

  const junction: ConnectionNode = {
    id: freshId(taken, createId),
    kind: 'junction',
    x: hosts[0]?.split.point.x ?? point.x,
    y: hosts[0]?.split.point.y ?? point.y,
  };
  const endpoint: Endpoint = { kind: 'node', node: junction.id };
  const hostsById = new Map(hosts.map((host) => [host.wire.id, host]));
  const wires: ConnectionWire[] = [];
  for (const wire of document.wires) {
    const host = hostsById.get(wire.id);
    if (host === undefined) {
      wires.push(wire);
      continue;
    }
    const halves = splitWire(wire, host.split, host.line, endpoint, taken, createId);
    wires.push(...halves);
  }
  return {
    document: { ...document, nodes: [...document.nodes, junction], wires },
    endpoint,
  };
}

interface IHostSplit {
  /** Index of the split vertex in the full polyline, or `-1` when it lies inside a segment. */
  readonly vertex: number;
  /** Segment index that contains the split point. */
  readonly segment: number;
  readonly point: Point2D;
}

function splitWire(
  wire: ConnectionWire,
  split: IHostSplit,
  line: readonly Point2D[],
  junction: Endpoint,
  taken: Set<string>,
  createId: () => string,
): readonly ConnectionWire[] {
  const last = line.length - 1;
  // The split point becomes the junction anchor, so it is dropped from both bend lists.
  const head = split.vertex >= 0 ? line.slice(1, split.vertex) : line.slice(1, split.segment + 1);
  const tail =
    split.vertex >= 0 ? line.slice(split.vertex + 1, last) : line.slice(split.segment + 1, last);
  return [
    { id: freshId(taken, createId), from: wire.from, to: junction, bends: head },
    { id: freshId(taken, createId), from: junction, to: wire.to, bends: tail },
  ];
}

function locateOnPolyline(line: readonly Point2D[], point: Point2D): IHostSplit | undefined {
  const last = line.length - 1;
  for (let vertex = 1; vertex < last; vertex += 1) {
    const candidate = line[vertex];
    if (candidate !== undefined && samePoint(candidate, point)) {
      return { vertex, segment: vertex, point: { x: candidate.x, y: candidate.y } };
    }
  }
  for (let segment = 0; segment < last; segment += 1) {
    const from = line[segment];
    const to = line[segment + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    const projected = projectOnSegment(point, from, to);
    const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
    if (distance > TAP_EPSILON) {
      continue;
    }
    if (segment === 0 && samePoint(projected, from)) {
      continue;
    }
    if (segment === last - 1 && samePoint(projected, to)) {
      continue;
    }
    return { vertex: -1, segment, point: { x: projected.x, y: projected.y } };
  }
  return undefined;
}

function pinAt(
  document: FusedDocument,
  devices: WiringDevices,
  point: Point2D,
): Endpoint | undefined {
  for (const instance of document.instances) {
    const geometry = devices.get(instance.device)?.geometry;
    if (geometry === undefined) {
      continue;
    }
    for (const pin of Object.keys(geometry.pins)) {
      const anchor = geometry.pins[pin];
      if (anchor === undefined) {
        continue;
      }
      const scene = localToScene(instance, geometry, anchor.position);
      if (samePoint(scene, point)) {
        return { kind: 'pin', instance: instance.id, pin };
      }
    }
  }
  return undefined;
}

function rerouteWire(
  wire: ConnectionWire,
  line: readonly Point2D[],
  devices: WiringDevices,
  previous: FusedDocument | undefined,
  previousWire: ConnectionWire | undefined,
): readonly Point2D[] {
  const start = line[0];
  const end = line[line.length - 1];
  if (start === undefined || end === undefined) {
    return orthogonalPath(line);
  }
  if (previous !== undefined && previousWire !== undefined) {
    const oldFrom = endpointPoint(previous, devices, previousWire.from);
    const oldTo = endpointPoint(previous, devices, previousWire.to);
    const sameBends = samePoints(previousWire.bends, wire.bends);
    if (oldFrom !== undefined && oldTo !== undefined && sameBends) {
      const startDelta = { x: start.x - oldFrom.x, y: start.y - oldFrom.y };
      const endDelta = { x: end.x - oldTo.x, y: end.y - oldTo.y };
      if (startDelta.x === endDelta.x && startDelta.y === endDelta.y) {
        // A whole run that moves together keeps its shape; only the anchors changed.
        const translated = [
          { x: start.x, y: start.y },
          ...wire.bends.map((bend) => ({
            x: bend.x + startDelta.x,
            y: bend.y + startDelta.y,
          })),
          { x: end.x, y: end.y },
        ];
        if (isOrthogonalPolyline(translated)) {
          return translated;
        }
      }
      let points: Point2D[] = [
        { x: oldFrom.x, y: oldFrom.y },
        ...wire.bends.map((bend) => ({ x: bend.x, y: bend.y })),
        { x: oldTo.x, y: oldTo.y },
      ];
      points = absorbEndpoint(points, 'start', { x: start.x, y: start.y });
      points = absorbEndpoint(points, 'end', { x: end.x, y: end.y });
      if (isOrthogonalPolyline(points)) {
        return points;
      }
    }
  }
  return orthogonalPath(line);
}

/**
 * Moves one anchor of an orthogonal polyline and absorbs the displacement by shifting the next
 * bend, exactly like the schematic symbol drag.
 *
 * Unlike the original pass, the loop stops one vertex before the far anchor: a fused wire must keep
 * both of its connection endpoints, so a displacement that reaches the other end is taken by a new
 * elbow instead of by moving that anchor.
 */
function absorbEndpoint(
  points: readonly Point2D[],
  end: 'start' | 'end',
  target: Point2D,
): Point2D[] {
  const next = points.map((point) => ({ x: point.x, y: point.y }));
  const last = next.length - 1;
  if (last < 1) {
    return next;
  }
  if (end === 'start') {
    next[0] = { x: target.x, y: target.y };
    for (let index = 0; index < last; index += 1) {
      const a = next[index];
      const b = next[index + 1];
      if (a === undefined || b === undefined || a.x === b.x || a.y === b.y) {
        break;
      }
      if (index + 1 === last) {
        next.splice(last, 0, elbow(a, b));
        break;
      }
      next[index + 1] = shifted(points, index, a, b);
    }
    return next;
  }
  next[last] = { x: target.x, y: target.y };
  for (let index = last; index > 0; index -= 1) {
    const a = next[index - 1];
    const b = next[index];
    if (a === undefined || b === undefined || a.x === b.x || a.y === b.y) {
      break;
    }
    if (index - 1 === 0) {
      next.splice(index, 0, elbow(a, b));
      break;
    }
    next[index - 1] = shifted(points, index - 1, a, b);
  }
  return next;
}

/** Restores the original orientation of one leg by moving its far vertex. */
function shifted(points: readonly Point2D[], index: number, a: Point2D, b: Point2D): Point2D {
  const before = points[index];
  const after = points[index + 1];
  const horizontal = before !== undefined && after !== undefined && before.y === after.y;
  return horizontal ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

/** The elbow of `orthogonalWaypoints` between two diagonal points. */
function elbow(a: Point2D, b: Point2D): Point2D {
  const [first] = orthogonalWaypoints(a, b);
  return first === undefined ? { x: a.x, y: b.y } : { x: first.x, y: first.y };
}

function isEndpoint(value: Endpoint | Point2D): value is Endpoint {
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'pin' || kind === 'node';
}

function readPoint(point: Point2D): Point2D {
  if (
    point === null ||
    typeof point !== 'object' ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    throw new TypeError('An anchor point needs finite "x" and "y" numbers.');
  }
  return { x: point.x, y: point.y };
}

function samePoint(left: Point2D, right: Point2D): boolean {
  return left.x === right.x && left.y === right.y;
}

function samePoints(left: readonly Point2D[], right: readonly Point2D[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((point, index) => {
    const other = right[index];
    return other !== undefined && samePoint(point, other);
  });
}

function takenIds(document: FusedDocument): Set<string> {
  return new Set<string>([
    ...document.instances.map((entry) => entry.id),
    ...document.nodes.map((entry) => entry.id),
    ...document.wires.map((entry) => entry.id),
    ...document.labels.map((entry) => entry.id),
    ...document.references.map((entry) => entry.id),
  ]);
}

function freshId(taken: Set<string>, createId: () => string): string {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const id = createId();
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  throw new Error('Could not allocate a unique element id for the anchor.');
}
