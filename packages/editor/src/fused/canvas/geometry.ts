import type {
  Endpoint,
  FusedDocument,
  FusedInstance,
  Geometry2D,
  NetLabel,
  Point2D,
  Rect2D,
  UnifiedDeviceManifest,
  VoltageReference,
} from '@mica-js/document/fused';
import type { IFusedTextTarget } from '../document/edits';
import type { IWorkbenchTarget } from '../types';

export interface ICanvasDevice {
  readonly manifest: UnifiedDeviceManifest;
  readonly geometry: Geometry2D;
}

export interface IViewport {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export function toScene(point: Point2D, viewport: IViewport): Point2D {
  return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
}

export function toScreen(point: Point2D, viewport: IViewport): Point2D {
  return { x: point.x * viewport.scale + viewport.x, y: point.y * viewport.scale + viewport.y };
}

export function localToScene(
  instance: FusedInstance,
  geometry: Geometry2D,
  point: Point2D,
): Point2D {
  const placement = instance.placement;
  const flexible = geometry.sizing === 'flexible';
  const x = flexible
    ? ((point.x - geometry.bounds.x) * (placement.width ?? geometry.bounds.width)) /
      geometry.bounds.width
    : point.x;
  const y = flexible
    ? ((point.y - geometry.bounds.y) * (placement.height ?? geometry.bounds.height)) /
      geometry.bounds.height
    : point.y;
  const angle = (placement.rotation * Math.PI) / 180;
  return {
    x: placement.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: placement.y + x * Math.sin(angle) + y * Math.cos(angle),
  };
}

export function sceneToLocal(
  instance: FusedInstance,
  geometry: Geometry2D,
  point: Point2D,
): Point2D {
  const angle = (-instance.placement.rotation * Math.PI) / 180;
  const dx = point.x - instance.placement.x;
  const dy = point.y - instance.placement.y;
  const x = dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = dx * Math.sin(angle) + dy * Math.cos(angle);
  if (geometry.sizing !== 'flexible') return { x, y };
  return {
    x:
      (x * geometry.bounds.width) / (instance.placement.width ?? geometry.bounds.width) +
      geometry.bounds.x,
    y:
      (y * geometry.bounds.height) / (instance.placement.height ?? geometry.bounds.height) +
      geometry.bounds.y,
  };
}

export function contains(rect: Rect2D, point: Point2D): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

export function endpointPosition(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  endpoint: Endpoint,
): Point2D {
  if (endpoint.kind === 'node') {
    const node = document.nodes.find((value) => value.id === endpoint.node);
    if (node === undefined) throw new Error(`Unknown connection node: ${endpoint.node}`);
    return node;
  }
  const instance = document.instances.find((value) => value.id === endpoint.instance);
  const device = instance === undefined ? undefined : devices.get(instance.device);
  const pin = device?.geometry.pins[endpoint.pin];
  if (instance === undefined || device === undefined || pin === undefined)
    throw new Error(`Unknown pin: ${endpoint.instance}/${endpoint.pin}`);
  return localToScene(instance, device.geometry, pin.position);
}

export interface IPinHit {
  readonly endpoint: Endpoint;
  readonly point: Point2D;
  readonly title: string;
}

export function pickPins(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  point: Point2D,
  tolerance: number,
): readonly IPinHit[] {
  return document.instances.flatMap((instance) => {
    const device = devices.get(instance.device);
    if (device === undefined) return [];
    return Object.entries(device.geometry.pins).flatMap(([pin, geometry]) => {
      const position = localToScene(instance, device.geometry, geometry.position);
      return Math.hypot(position.x - point.x, position.y - point.y) <= tolerance
        ? [
            {
              endpoint: { kind: 'pin' as const, instance: instance.id, pin },
              point: position,
              title: `${instance.designator ?? instance.id} · ${device.manifest.pins?.[pin]?.label ?? pin}`,
            },
          ]
        : [];
    });
  });
}

export function pickInstance(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  point: Point2D,
  visible: (instance: FusedInstance) => boolean = () => true,
): FusedInstance | undefined {
  return [...document.instances].reverse().find((instance) => {
    const device = devices.get(instance.device);
    return (
      device !== undefined &&
      visible(instance) &&
      contains(device.geometry.bounds, sceneToLocal(instance, device.geometry, point))
    );
  });
}

export function labelBounds(label: NetLabel): Rect2D {
  return {
    x: label.offset?.x ?? 0.3,
    y: (label.offset?.y ?? -0.35) - 0.75,
    width: Math.max(0.5, label.name.length * 0.5),
    height: 0.9,
  };
}

export function designatorPosition(instance: FusedInstance, geometry: Geometry2D): Point2D {
  const anchor = geometry.designator ?? { x: geometry.bodyBounds.x, y: geometry.bodyBounds.y };
  return localToScene(instance, geometry, {
    x: anchor.x + (instance.designatorOffset?.x ?? 0),
    y: anchor.y + (instance.designatorOffset?.y ?? 0),
  });
}

export function referenceTextBounds(reference: VoltageReference): Rect2D {
  const name = reference.label?.name ?? `${reference.voltage} V`;
  return {
    x: reference.label?.offset?.x ?? 0.7,
    y: (reference.label?.offset?.y ?? -1.4) - 0.75,
    width: Math.max(0.5, name.length * 0.5),
    height: 0.9,
  };
}

function referenceToLocal(reference: VoltageReference, delta: Point2D): Point2D {
  const angle = -((reference.rotation ?? 0) * Math.PI) / 180;
  return {
    x: delta.x * Math.cos(angle) - delta.y * Math.sin(angle),
    y: delta.x * Math.sin(angle) + delta.y * Math.cos(angle),
  };
}

export function pickText(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  point: Point2D,
  scale: number,
): IFusedTextTarget | undefined {
  for (const reference of [...document.references].reverse()) {
    if (reference.symbol === 'ground' || reference.label === undefined) continue;
    const anchor = endpointPosition(document, devices, reference.target);
    const local = referenceToLocal(reference, { x: point.x - anchor.x, y: point.y - anchor.y });
    if (containsExpanded(referenceTextBounds(reference), local, 2 / scale))
      return { kind: 'reference', id: reference.id };
  }
  for (const label of [...document.labels].reverse()) {
    const anchor = endpointPosition(document, devices, label.target);
    if (
      containsExpanded(
        labelBounds(label),
        { x: point.x - anchor.x, y: point.y - anchor.y },
        2 / scale,
      )
    )
      return { kind: 'label', id: label.id };
  }
  for (const instance of [...document.instances].reverse()) {
    const geometry = devices.get(instance.device)?.geometry;
    if (instance.designator === undefined || geometry === undefined) continue;
    const anchor = designatorPosition(instance, geometry);
    if (
      containsExpanded(
        {
          x: anchor.x,
          y: anchor.y - 16 / scale,
          width: (instance.designator.length * 7) / scale,
          height: 13 / scale,
        },
        point,
        2 / scale,
      )
    )
      return { kind: 'designator', id: instance.id };
  }
  return undefined;
}

/** Converts a scene-space text drag into the persisted offset in its owner's coordinates. */
export function textDragOffset(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  target: IFusedTextTarget,
  delta: Point2D,
): Point2D {
  if (target.kind === 'designator') {
    const instance = document.instances.find((value) => value.id === target.id);
    const geometry = instance === undefined ? undefined : devices.get(instance.device)?.geometry;
    if (instance === undefined || geometry === undefined)
      throw new Error(`Unknown designator: ${target.id}`);
    const origin = sceneToLocal(instance, geometry, instance.placement);
    const moved = sceneToLocal(instance, geometry, {
      x: instance.placement.x + delta.x,
      y: instance.placement.y + delta.y,
    });
    return {
      x: (instance.designatorOffset?.x ?? 0) + moved.x - origin.x,
      y: (instance.designatorOffset?.y ?? 0) + moved.y - origin.y,
    };
  }
  if (target.kind === 'label') {
    const label = document.labels.find((value) => value.id === target.id);
    if (label === undefined) throw new Error(`Unknown label: ${target.id}`);
    return { x: (label.offset?.x ?? 0.3) + delta.x, y: (label.offset?.y ?? -0.35) + delta.y };
  }
  const reference = document.references.find((value) => value.id === target.id);
  if (reference?.label === undefined)
    throw new Error(`Reference has no movable net label: ${target.id}`);
  const local = referenceToLocal(reference, delta);
  return {
    x: (reference.label.offset?.x ?? 0.7) + local.x,
    y: (reference.label.offset?.y ?? -1.4) + local.y,
  };
}

export function referenceSymbolBounds(reference: VoltageReference): Rect2D {
  return reference.symbol === 'ground'
    ? { x: -0.7, y: -1.8, width: 1.4, height: 1.8 }
    : { x: -0.5, y: -1.3, width: 1, height: 1.3 };
}

export function referenceBounds(reference: VoltageReference): Rect2D {
  const symbol = referenceSymbolBounds(reference);
  if (reference.symbol === 'ground') return symbol;
  const text = referenceTextBounds(reference);
  const left = Math.min(symbol.x, text.x);
  const top = Math.min(symbol.y, text.y);
  return {
    x: left,
    y: top,
    width: Math.max(symbol.x + symbol.width, text.x + text.width) - left,
    height: Math.max(symbol.y + symbol.height, text.y + text.height) - top,
  };
}

/** Annotation symbols use the same anchor, rotation and bounds for painting and picking. */
export function pickAnnotation(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  point: Point2D,
  tolerance: number,
): { readonly kind: 'reference' | 'label'; readonly id: string } | undefined {
  for (const reference of [...document.references].reverse()) {
    const anchor = endpointPosition(document, devices, reference.target);
    const local = referenceToLocal(reference, { x: point.x - anchor.x, y: point.y - anchor.y });
    if (containsExpanded(referenceBounds(reference), local, tolerance))
      return { kind: 'reference', id: reference.id };
  }
  for (const label of [...document.labels].reverse()) {
    const anchor = endpointPosition(document, devices, label.target);
    if (
      containsExpanded(
        labelBounds(label),
        { x: point.x - anchor.x, y: point.y - anchor.y },
        tolerance,
      )
    )
      return { kind: 'label', id: label.id };
  }
  return undefined;
}

/**
 * Object a double click configures: text (an embedded net name or designator) wins over an
 * annotation symbol, which wins over a device body, matching the click-selection order.
 */
export function pickDoubleClickTarget(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  point: Point2D,
  scale: number,
): IWorkbenchTarget | undefined {
  const text = pickText(document, devices, point, scale);
  if (text !== undefined) {
    return text.kind === 'designator'
      ? { kind: 'instance', id: text.id }
      : { kind: text.kind, id: text.id };
  }
  const annotation = pickAnnotation(document, devices, point, 3 / scale);
  if (annotation !== undefined) return annotation;
  const instance = pickInstance(document, devices, point);
  return instance === undefined ? undefined : { kind: 'instance', id: instance.id };
}

function containsExpanded(bounds: Rect2D, point: Point2D, tolerance: number): boolean {
  return contains(
    {
      x: bounds.x - tolerance,
      y: bounds.y - tolerance,
      width: bounds.width + tolerance * 2,
      height: bounds.height + tolerance * 2,
    },
    point,
  );
}

export interface IBodyOverlap {
  readonly first: FusedInstance;
  readonly second: FusedInstance;
}

export function findBodyOverlaps(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
): readonly IBodyOverlap[] {
  const bodies = document.instances.flatMap((instance) => {
    const geometry = devices.get(instance.device)?.geometry;
    if (geometry === undefined) return [];
    const rect = geometry.bodyBounds;
    return [
      {
        instance,
        points: [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height },
          { x: rect.x, y: rect.y + rect.height },
        ].map((point) => localToScene(instance, geometry, point)),
      },
    ];
  });
  const overlaps: IBodyOverlap[] = [];
  for (const [index, first] of bodies.entries()) {
    for (const second of bodies.slice(index + 1)) {
      const separated = [first.points, second.points].some((points) =>
        points.some((point, edge) => {
          const next = points[(edge + 1) % points.length];
          if (next === undefined) return false;
          const axis = { x: point.y - next.y, y: next.x - point.x };
          const length = Math.hypot(axis.x, axis.y);
          const project = (value: Point2D) => (value.x * axis.x + value.y * axis.y) / length;
          const a = first.points.map(project);
          const b = second.points.map(project);
          return Math.max(...a) <= Math.min(...b) + 1e-9 || Math.max(...b) <= Math.min(...a) + 1e-9;
        }),
      );
      if (!separated) overlaps.push({ first: first.instance, second: second.instance });
    }
  }
  return overlaps;
}

export function distanceToSegment(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

export function pickWireSegment(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  point: Point2D,
  tolerance: number,
): { readonly wireId: string; readonly segment: number } | undefined {
  let hit: { wireId: string; segment: number; distance: number } | undefined;
  for (const wire of document.wires) {
    const points = [
      endpointPosition(document, devices, wire.from),
      ...wire.bends,
      endpointPosition(document, devices, wire.to),
    ];
    for (let segment = 0; segment < points.length - 1; segment++) {
      const from = points[segment]!;
      const to = points[segment + 1]!;
      if (from.x === to.x && from.y === to.y) continue;
      const distance = distanceToSegment(point, from, to);
      if (distance <= tolerance && (hit === undefined || distance < hit.distance))
        hit = { wireId: wire.id, segment, distance };
    }
  }
  return hit;
}

export function fitViewport(
  document: FusedDocument,
  devices: ReadonlyMap<string, ICanvasDevice>,
  width: number,
  height: number,
): IViewport {
  const points = [
    ...document.nodes,
    ...document.wires.flatMap((wire) => wire.bends),
    ...document.instances.flatMap((instance) => {
      const bounds = devices.get(instance.device)?.geometry.bounds;
      const geometry = devices.get(instance.device)?.geometry;
      return bounds === undefined || geometry === undefined
        ? []
        : [
            { x: bounds.x, y: bounds.y },
            { x: bounds.x + bounds.width, y: bounds.y },
            { x: bounds.x, y: bounds.y + bounds.height },
            { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
          ].map((point) => localToScene(instance, geometry, point));
    }),
  ];
  if (!points.length) return { scale: 10, x: width / 2, y: height / 2 };
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  const scale = Math.max(
    0.25,
    Math.min(
      50,
      Math.max(1, width - 96) / Math.max(1, right - left),
      Math.max(1, height - 96) / Math.max(1, bottom - top),
    ),
  );
  return {
    scale,
    x: width / 2 - ((left + right) / 2) * scale,
    y: height / 2 - ((top + bottom) / 2) * scale,
  };
}
