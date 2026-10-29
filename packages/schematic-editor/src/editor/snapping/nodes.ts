import {
  GROUND_DEVICE,
  LABEL_DEVICE,
  POWER_DEVICE,
  parseDeviceReference,
  symbolPinPosition,
  type DeviceSymbolProvider,
  type HitTestOptions,
  type Point,
  type SchematicDocument,
  type SchematicHit,
} from '@mica-js/core/schematic';
import type { DisplayOptions } from '../../types';

/** Screen-space hit radius; callers divide by the viewport scale. */
export const MIN_HIT_PIXELS = 6;

export interface SnapContext {
  readonly document: SchematicDocument;
  readonly display: DisplayOptions;
  readonly devices: DeviceSymbolProvider | undefined;
  /** Hit tolerance in page units. */
  readonly tolerance: number;
  readonly hitTest: (point: Point, options?: HitTestOptions) => SchematicHit | undefined;
}

/** World position of a pin / label / power / ground anchor under `point`. */
export function connectionNodeAt(context: SnapContext, point: Point): Point | undefined {
  const hit = context.hitTest(point, {
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
  for (const wire of context.document.sheet.wires) {
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
  for (const symbol of context.document.sheet.symbols) {
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
  const symbol = context.document.sheet.symbols.find((item) => item.id === hit.symbolId);
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
