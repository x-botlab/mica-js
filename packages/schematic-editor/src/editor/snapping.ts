import {
  DEFAULT_TEXT_CONTENT,
  GROUND_DEVICE,
  LABEL_DEVICE,
  POWER_DEVICE,
  TEXT_DEVICE,
  isTextDevice,
  netNameOf,
  parseDeviceReference,
  pinSide,
  pinsBounds,
  rotatePoint,
  symbolPinPosition,
  type DeviceSymbolProvider,
  type Point,
  type SchematicDocument,
} from '@mica/core/schematic';
import type { SchematicEditorController } from '../controller/controller';
import type { DisplayOptions, EditorTool } from '../controller/types';

/** Screen-space hit radius; callers divide by the viewport scale. */
export const MIN_HIT_PIXELS = 6;

export interface SnapContext {
  readonly controller: SchematicEditorController;
  readonly devices: DeviceSymbolProvider | undefined;
  /** Hit tolerance in page units. */
  readonly tolerance: number;
}

export function isPlacementTool(tool: EditorTool): boolean {
  return tool === 'power' || tool === 'ground' || tool === 'label' || tool === 'text';
}

export function toolDevice(tool: EditorTool): string {
  switch (tool) {
    case 'power':
      return POWER_DEVICE;
    case 'ground':
      return GROUND_DEVICE;
    case 'label':
      return LABEL_DEVICE;
    default:
      return TEXT_DEVICE;
  }
}

export function snapToGrid(point: Point, display: DisplayOptions): Point {
  if (!display.snap || !(display.gridSize > 0)) {
    return point;
  }
  const size = display.gridSize;
  return { x: Math.round(point.x / size) * size, y: Math.round(point.y / size) * size };
}

/**
 * Waypoints needed to reach `to` from `from` with horizontal/vertical segments only.
 * Returns `[to]` when already aligned, otherwise an elbow plus `to` (long axis first).
 */
export function orthogonalWaypoints(from: Point, to: Point): readonly Point[] {
  if (from.x === to.x || from.y === to.y) {
    return [to];
  }
  const elbow =
    Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
      ? { x: to.x, y: from.y }
      : { x: from.x, y: to.y };
  return [elbow, to];
}

/** Snaps to a nearby connection node when there is one, otherwise to the grid. */
export function snapForWire(context: SnapContext, point: Point): Point {
  return connectionNodeAt(context, point) ?? snapToGrid(point, context.controller.display);
}

/** World position of a pin / label / power / ground anchor under `point`. */
export function connectionNodeAt(context: SnapContext, point: Point): Point | undefined {
  const hit = context.controller.hitTest(point, {
    tolerance: context.tolerance * 2,
    includeSymbols: false,
  });
  if (hit?.kind === 'pin') {
    return pinPosition(context, hit);
  }
  const anchor = anchorSymbolAt(context, point);
  if (anchor !== undefined) {
    return { x: anchor.x, y: anchor.y };
  }
  return wireEndpointAt(context, point);
}

/** Endpoint of an existing wire under `point`; used to close a connection. */
export function wireEndpointAt(context: SnapContext, point: Point): Point | undefined {
  for (const wire of context.controller.document.sheet.wires) {
    for (const endpoint of [wire.points[0], wire.points[wire.points.length - 1]]) {
      if (
        endpoint !== undefined &&
        Math.abs(endpoint.x - point.x) <= context.tolerance * 2 &&
        Math.abs(endpoint.y - point.y) <= context.tolerance * 2
      ) {
        return { x: endpoint.x, y: endpoint.y };
      }
    }
  }
  return undefined;
}

/** Builtin connection symbol (label / power / ground) anchored under `point`. */
export function anchorSymbolAt(
  context: SnapContext,
  point: Point,
): { readonly x: number; readonly y: number } | undefined {
  // Anchors sit on wire endpoints, where `hitTest` reports the wire first, so scan directly.
  for (const symbol of context.controller.document.sheet.symbols) {
    const device = symbol.device;
    if (device !== LABEL_DEVICE && device !== POWER_DEVICE && device !== GROUND_DEVICE) {
      continue;
    }
    if (
      Math.abs(symbol.x - point.x) <= context.tolerance &&
      Math.abs(symbol.y - point.y) <= context.tolerance
    ) {
      return symbol;
    }
  }
  return undefined;
}

export function pinPosition(
  context: SnapContext,
  hit: { readonly symbolId: string; readonly pinId: string },
): Point | undefined {
  const symbol = context.controller.document.sheet.symbols.find((item) => item.id === hit.symbolId);
  if (symbol === undefined) {
    return undefined;
  }
  const reference = parseDeviceReference(symbol.device);
  const anchor =
    reference === undefined
      ? undefined
      : context.devices?.getDeviceSymbol(reference)?.pins[hit.pinId];
  return anchor === undefined ? undefined : symbolPinPosition(symbol, anchor);
}

/** Smallest unused `N<n>` net name for a freshly placed net label. */
export function nextNetName(document: SchematicDocument): string {
  const used = new Set(
    document.sheet.symbols
      .map((symbol) => netNameOf(symbol))
      .filter((name): name is string => name !== undefined),
  );
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `N${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return 'N';
}

/** Length of the lead added when a label is dropped straight onto a pin. */
export const LABEL_STUB_LENGTH = 20;

export interface LabelStub {
  /** Pin connection point. */
  readonly pin: Point;
  /** Where the label anchor goes: one lead away from the pin. */
  readonly anchor: Point;
  /** Rotation that draws the net name away from the symbol. */
  readonly rotation: number;
  /** Lead to insert; absent when an existing wire already reaches the anchor. */
  readonly wire?: readonly Point[];
}

/**
 * Lead used when a label is placed directly on a pin: labels hang off a short wire in the pin's
 * outward direction instead of sitting on the pin itself.
 */
export function labelStubAt(context: SnapContext, point: Point): LabelStub | undefined {
  const hit = context.controller.hitTest(point, {
    tolerance: context.tolerance * 2,
    includeSymbols: false,
  });
  if (hit?.kind !== 'pin') {
    return undefined;
  }
  const pin = pinPosition(context, hit);
  const direction = pinOutward(context, hit);
  if (pin === undefined || direction === undefined) {
    return undefined;
  }
  // Directions are axis aligned, so rounding removes the rotation's floating point noise.
  const dx = Math.round(direction.x);
  const dy = Math.round(direction.y);
  const anchor = {
    x: pin.x + dx * LABEL_STUB_LENGTH,
    y: pin.y + dy * LABEL_STUB_LENGTH,
  };
  const rotation = dx > 0 ? 0 : dx < 0 ? 180 : dy > 0 ? 90 : 270;
  return { pin, anchor, rotation, ...stubWire(context, pin, anchor) };
}

/** The lead only has to be drawn where no wire already runs; labels bind to any wire they touch. */
function stubWire(
  context: SnapContext,
  pin: Point,
  anchor: Point,
): { readonly wire?: readonly Point[] } {
  const host = context.controller.hitTest(anchor, {
    includeSymbols: false,
    tolerance: context.tolerance,
  });
  return host?.kind === 'wire' ? {} : { wire: [pin, anchor] };
}

/** Unit vector, in world space, pointing away from the symbol body at a pin. */
function pinOutward(
  context: SnapContext,
  hit: { readonly symbolId: string; readonly pinId: string },
): Point | undefined {
  const symbol = context.controller.document.sheet.symbols.find((item) => item.id === hit.symbolId);
  const reference = symbol === undefined ? undefined : parseDeviceReference(symbol.device);
  const definition =
    reference === undefined ? undefined : context.devices?.getDeviceSymbol(reference);
  const anchor = definition?.pins[hit.pinId];
  if (symbol === undefined || definition === undefined || anchor === undefined) {
    return undefined;
  }
  const side = pinSide(anchor, definition.bounds ?? pinsBounds(definition.pins));
  const local =
    side === 'left'
      ? { x: -1, y: 0 }
      : side === 'right'
        ? { x: 1, y: 0 }
        : side === 'top'
          ? { x: 0, y: -1 }
          : side === 'bottom'
            ? { x: 0, y: 1 }
            : undefined;
  return local === undefined ? undefined : rotatePoint(local, symbol.rotation);
}

/** Extra properties written when a placement inserts a builtin symbol. */
export function placementProperties(device: string): Record<string, string> | undefined {
  return isTextDevice(device) ? { text: DEFAULT_TEXT_CONTENT } : undefined;
}
