import type { Placement, Point, Rect } from '../format/types';
import type { PinAnchor } from '../device/symbol';
import { boundsOfPoints } from './point';

/** Rotates counter-clockwise around the origin. Rotation is expressed in degrees. */
export function rotatePoint(point: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

/** Applies a symbol placement to a pre-placement anchor. */
export function symbolPinPosition(placement: Placement, anchor: PinAnchor): Point {
  const rotated = rotatePoint(anchor, placement.rotation);
  return { x: placement.x + rotated.x, y: placement.y + rotated.y };
}

/** Distance between the reference default anchor and the body's top-left corner. */
export const REFERENCE_DEFAULT_OFFSET = 4;

/**
 * Local anchor of a symbol's reference designator: the explicit override, else the body's
 * top-left corner lifted by {@link REFERENCE_DEFAULT_OFFSET}.
 */
export function referenceAnchor(outline: Rect | undefined, override?: Point): Point {
  if (override !== undefined) {
    return { x: override.x, y: override.y };
  }
  if (outline === undefined) {
    return { x: 0, y: -REFERENCE_DEFAULT_OFFSET };
  }
  return { x: outline.x, y: outline.y - REFERENCE_DEFAULT_OFFSET };
}

/** World position of a symbol's reference designator anchor. */
export function referencePosition(
  placement: Placement,
  outline: Rect | undefined,
  override?: Point,
): Point {
  return symbolPinPosition(placement, referenceAnchor(outline, override));
}

/** Bounding box of a symbol: its transformed outline, else its pins, else its origin. */
export function symbolBounds(
  placement: Placement,
  outline: Rect | undefined,
  pins: Readonly<Record<string, PinAnchor>>,
): Rect | undefined {
  if (outline !== undefined) {
    const corners: Point[] = [
      { x: outline.x, y: outline.y },
      { x: outline.x + outline.width, y: outline.y },
      { x: outline.x, y: outline.y + outline.height },
      { x: outline.x + outline.width, y: outline.y + outline.height },
    ];
    return boundsOfPoints(corners.map((corner) => symbolPinPosition(placement, corner)));
  }
  const anchors = Object.values(pins).map((anchor) => symbolPinPosition(placement, anchor));
  if (anchors.length > 0) {
    return boundsOfPoints(anchors);
  }
  return { x: placement.x, y: placement.y, width: 0, height: 0 };
}
