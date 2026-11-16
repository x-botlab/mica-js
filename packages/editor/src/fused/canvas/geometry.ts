import type {
  Endpoint,
  FusedDocument,
  FusedInstance,
  Geometry2D,
  Point2D,
  Rect2D,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';

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
