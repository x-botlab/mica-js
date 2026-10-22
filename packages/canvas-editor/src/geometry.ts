import type { WidgetPlacement } from '@mica-js/core/canvas';

/**
 * Pure 2D geometry of the canvas editor. Nothing here touches the DOM or the document, so hit
 * testing and the resize/rotate math run in Node tests.
 *
 * All functions work in document units: 1 unit is 1 CSS pixel at 100 % zoom.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];
export type CanvasHandle = ResizeHandle | 'rotate';

const CORNER_HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];
const EDGE_HANDLES: readonly ResizeHandle[] = ['n', 'e', 's', 'w'];

/** Smallest width/height a resize produces, in document units. */
export const MIN_INSTANCE_SIZE = 1;

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Any angle → `[0, 360)`, so rotations stay comparable and serializable. */
export function normalizeDegrees(degrees: number): number {
  const normalized = degrees % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

/** Rounds to the nearest `step`, used for the 15° `Shift` snap. */
export function snapDegrees(degrees: number, step = 15): number {
  return Math.round(degrees / step) * step;
}

/** Rotates a vector clockwise, matching `ctx.rotate` (y grows downwards). */
export function rotateVector(vector: Point, degrees: number): Point {
  const radians = degreesToRadians(degrees);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

export function placementCenter(placement: WidgetPlacement): Point {
  return { x: placement.x + placement.width / 2, y: placement.y + placement.height / 2 };
}

/** Document point → offset from the instance center with the instance rotation removed. */
export function toLocalPoint(placement: WidgetPlacement, point: Point): Point {
  const center = placementCenter(placement);
  return rotateVector({ x: point.x - center.x, y: point.y - center.y }, -placement.rotation);
}

/** Offset from the instance center in its unrotated frame → document point. */
export function localToDocument(placement: WidgetPlacement, local: Point): Point {
  const center = placementCenter(placement);
  const offset = rotateVector(local, placement.rotation);
  return { x: center.x + offset.x, y: center.y + offset.y };
}

/** True when `point` is inside the rotation-aware rectangle of `placement`. */
export function containsPoint(placement: WidgetPlacement, point: Point): boolean {
  const local = toLocalPoint(placement, point);
  return Math.abs(local.x) <= placement.width / 2 && Math.abs(local.y) <= placement.height / 2;
}

/** Topmost instance under `point`; the last entry paints above the earlier ones. */
export function hitTestTopmost<T extends WidgetPlacement & { readonly id: string }>(
  instances: readonly T[],
  point: Point,
): T | undefined {
  for (let index = instances.length - 1; index >= 0; index -= 1) {
    const instance = instances[index];
    if (instance !== undefined && containsPoint(instance, point)) {
      return instance;
    }
  }
  return undefined;
}

/** Corners in draw order: top-left, top-right, bottom-right, bottom-left. */
export function placementCorners(placement: WidgetPlacement): readonly Point[] {
  const halfWidth = placement.width / 2;
  const halfHeight = placement.height / 2;
  return [
    localToDocument(placement, { x: -halfWidth, y: -halfHeight }),
    localToDocument(placement, { x: halfWidth, y: -halfHeight }),
    localToDocument(placement, { x: halfWidth, y: halfHeight }),
    localToDocument(placement, { x: -halfWidth, y: halfHeight }),
  ];
}

/** Axis-aligned bounding box of the rotated instance, for host overlays and tests. */
export function placementBounds(placement: WidgetPlacement): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of placementCorners(placement)) {
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, corner.y);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, corner.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Handle positions in document units. `rotateOffset` is the distance of the rotation handle above
 * the top edge; callers divide the desired screen distance by the zoom scale.
 */
export function handlePoints(
  placement: WidgetPlacement,
  rotateOffset = 0,
): Readonly<Record<CanvasHandle, Point>> {
  const halfWidth = placement.width / 2;
  const halfHeight = placement.height / 2;
  const at = (x: number, y: number): Point => localToDocument(placement, { x, y });
  return {
    nw: at(-halfWidth, -halfHeight),
    n: at(0, -halfHeight),
    ne: at(halfWidth, -halfHeight),
    e: at(halfWidth, 0),
    se: at(halfWidth, halfHeight),
    s: at(0, halfHeight),
    sw: at(-halfWidth, halfHeight),
    w: at(-halfWidth, 0),
    rotate: at(0, -halfHeight - rotateOffset),
  };
}

/** Nearest handle within `radius`; corners win over edges and the rotation handle wins over both. */
export function hitTestHandle(
  placement: WidgetPlacement,
  point: Point,
  radius: number,
  rotateOffset = 0,
): CanvasHandle | undefined {
  const points = handlePoints(placement, rotateOffset);
  if (distance(points.rotate, point) <= radius) {
    return 'rotate';
  }
  for (const handle of CORNER_HANDLES) {
    if (distance(points[handle], point) <= radius) {
      return handle;
    }
  }
  for (const handle of EDGE_HANDLES) {
    if (distance(points[handle], point) <= radius) {
      return handle;
    }
  }
  return undefined;
}

export interface ResizeOptions {
  /** Keeps the starting aspect ratio, used while `Shift` is held. */
  readonly keepAspect?: boolean;
  readonly minSize?: number;
}

/**
 * Drags one handle to `pointer` and returns the new placement. The edges opposite to `handle` stay
 * where they are, and the rotation is preserved, so a rotated instance scales along its own axes.
 */
export function resizePlacement(
  placement: WidgetPlacement,
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions = {},
): WidgetPlacement {
  const minSize = options.minSize ?? MIN_INSTANCE_SIZE;
  const center = placementCenter(placement);
  const local = toLocalPoint(placement, pointer);
  const halfWidth = placement.width / 2;
  const halfHeight = placement.height / 2;

  let width = placement.width;
  let height = placement.height;
  if (handle.includes('e')) {
    width = Math.max(minSize, local.x + halfWidth);
  }
  if (handle.includes('w')) {
    width = Math.max(minSize, halfWidth - local.x);
  }
  if (handle.includes('s')) {
    height = Math.max(minSize, local.y + halfHeight);
  }
  if (handle.includes('n')) {
    height = Math.max(minSize, halfHeight - local.y);
  }

  if (options.keepAspect === true && width > 0 && height > 0) {
    const ratio = placement.width / placement.height;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      // A degenerate start has no ratio to keep; fall back to the free resize above.
    } else if (CORNER_HANDLES.includes(handle)) {
      // Corners follow the dominant axis so the box never collapses while the pointer moves.
      const scale = Math.max(width / placement.width, height / placement.height);
      width = Math.max(minSize, placement.width * scale);
      height = Math.max(minSize, width / ratio);
    } else if (handle === 'e' || handle === 'w') {
      height = Math.max(minSize, width / ratio);
    } else {
      width = Math.max(minSize, height * ratio);
    }
  }

  // `left`/`top` are the new top-left corner in the old center's frame: the dragged edge moves,
  // the opposite edge stays pinned, and an untouched axis grows symmetrically.
  const left = handle.includes('w')
    ? halfWidth - width
    : handle.includes('e')
      ? -halfWidth
      : -width / 2;
  const top = handle.includes('n')
    ? halfHeight - height
    : handle.includes('s')
      ? -halfHeight
      : -height / 2;
  const offset = rotateVector({ x: left + width / 2, y: top + height / 2 }, placement.rotation);
  const centerX = center.x + offset.x;
  const centerY = center.y + offset.y;

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: placement.rotation,
  };
}

/** Screen angle of `point` around `center`, in degrees, clockwise from the +x axis. */
export function pointerAngle(center: Point, point: Point): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
}

export interface RotationOptions {
  /** `startRotation - (startPointerAngle + 90)`, so grabbing the handle never jumps the instance. */
  readonly grabOffset?: number;
  /** Snaps the result to 15° steps, used while `Shift` is held. */
  readonly snap?: boolean;
}

/** Rotation (degrees, clockwise, around the center) that puts the rotate handle under `pointer`. */
export function rotationFromPointer(
  center: Point,
  pointer: Point,
  options: RotationOptions = {},
): number {
  // The handle sits above the center at rotation 0, so the pointer angle is offset by 90°.
  const raw = pointerAngle(center, pointer) + 90 + (options.grabOffset ?? 0);
  return normalizeDegrees(options.snap === true ? snapDegrees(raw) : raw);
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
