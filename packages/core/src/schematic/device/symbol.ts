import type { Rect } from '../format/types';
import type { DeviceReference } from './reference';

/** Side of the symbol body a pin is drawn on; controls stub direction and label placement. */
export type PinSide = 'left' | 'right' | 'top' | 'bottom';

export interface PinAnchor {
  /** Connection point (outer end of the pin stub) in symbol space. */
  readonly x: number;
  readonly y: number;
  /** Side the pin is displayed on; inferred from the position when omitted. */
  readonly side?: PinSide;
}

export interface DeviceSymbolDefinition {
  /** Name rendered at the centre of the symbol. */
  readonly name: string;
  /** Pin id to pre-placement anchor coordinate in symbol space. */
  readonly pins: Readonly<Record<string, PinAnchor>>;
  /** Optional outline used by the editor to draw the symbol body. */
  readonly bounds?: Rect;
}

export interface DeviceSymbolGeometry {
  /** Placement-independent geometry, as provided by the device description. */
  readonly name?: string;
  readonly pins: Readonly<Record<string, PinAnchor>>;
  readonly bounds?: Rect;
}

export interface DeviceSymbolProvider {
  /** Symbol geometry; `undefined` when the device is unknown or has no geometry. */
  getDeviceSymbol(reference: DeviceReference): DeviceSymbolDefinition | undefined;
  /** Name rendered on the symbol: the symbol name, else the display name. `undefined` when unknown. */
  getDeviceName(reference: DeviceReference): string | undefined;
}

/** Bounding box of a device's pins; `undefined` when it declares none. */
export function pinsBounds(pins: Readonly<Record<string, PinAnchor>>): Rect | undefined {
  const points = Object.values(pins);
  if (points.length === 0) {
    return undefined;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Side a pin is drawn on: its declared side, else the closest edge of the body outline. */
export function pinSide(pin: PinAnchor, outline: Rect | undefined): PinSide | undefined {
  if (pin.side !== undefined) {
    return pin.side;
  }
  if (outline === undefined) {
    return undefined;
  }
  const dx = (pin.x - (outline.x + outline.width / 2)) / Math.max(outline.width / 2, 1e-6);
  const dy = (pin.y - (outline.y + outline.height / 2)) / Math.max(outline.height / 2, 1e-6);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'bottom' : 'top';
}

/**
 * Inner end of a pin stub, where it meets the body outline. Together with the anchor it forms the
 * grabbable pin: rendering draws that line and hit testing accepts clicks anywhere along it.
 */
export function pinStubEnd(
  body: Rect,
  anchor: { readonly x: number; readonly y: number },
  side: PinSide,
): { readonly x: number; readonly y: number } {
  switch (side) {
    case 'left':
      return { x: body.x, y: anchor.y };
    case 'right':
      return { x: body.x + body.width, y: anchor.y };
    case 'top':
      return { x: anchor.x, y: body.y };
    case 'bottom':
      return { x: anchor.x, y: body.y + body.height };
  }
}
