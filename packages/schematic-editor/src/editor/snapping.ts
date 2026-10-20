import {
  DEFAULT_TEXT_CONTENT,
  GROUND_DEVICE,
  LABEL_DEVICE,
  POWER_DEVICE,
  TEXT_DEVICE,
  parseDeviceReference,
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

/** Smallest unused `N<n>` id; a label's id is its net name. */
export function nextLabelName(document: SchematicDocument): string {
  const used = new Set(document.sheet.symbols.map((symbol) => symbol.id));
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `N${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return 'N';
}

/** Extra properties written when a placement tool inserts a builtin symbol. */
export function placementProperties(tool: EditorTool): Record<string, string> | undefined {
  return tool === 'text' ? { text: DEFAULT_TEXT_CONTENT } : undefined;
}
