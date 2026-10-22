import type { Point } from './geometry';

/**
 * Zoom/pan state of the canvas surface. `x`/`y` are the screen-space position of the document
 * origin, so a document point maps to `point * scale + offset`.
 */
export interface ViewportState {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export const MIN_VIEWPORT_SCALE = 0.1;
export const MAX_VIEWPORT_SCALE = 8;

export const IDENTITY_VIEWPORT: ViewportState = { x: 0, y: 0, scale: 1 };

/** Clamps a scale to the supported range; NaN or non-positive values fall back to the minimum. */
export function clampScale(scale: number): number {
  if (Number.isNaN(scale) || scale <= 0) {
    return MIN_VIEWPORT_SCALE;
  }
  return Math.min(MAX_VIEWPORT_SCALE, Math.max(MIN_VIEWPORT_SCALE, scale));
}

/** Screen (CSS pixel) point → document units. */
export function screenToDocument(viewport: ViewportState, point: Point): Point {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}

/** Document units → screen (CSS pixel) point. */
export function documentToScreen(viewport: ViewportState, point: Point): Point {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y,
  };
}

export function panBy(viewport: ViewportState, dx: number, dy: number): ViewportState {
  return { x: viewport.x + dx, y: viewport.y + dy, scale: viewport.scale };
}

/** Zooms around a screen point, keeping the document point under it in place. */
export function zoomAt(viewport: ViewportState, screenPoint: Point, factor: number): ViewportState {
  if (!Number.isFinite(factor) || factor <= 0) {
    return viewport;
  }
  return zoomTo(viewport, screenPoint, viewport.scale * factor);
}

/** Scales to an absolute factor around a screen point, clamped to the supported range. */
export function zoomTo(viewport: ViewportState, screenPoint: Point, scale: number): ViewportState {
  const next = clampScale(scale);
  if (next === viewport.scale) {
    return viewport;
  }
  const anchor = screenToDocument(viewport, screenPoint);
  return {
    x: screenPoint.x - anchor.x * next,
    y: screenPoint.y - anchor.y * next,
    scale: next,
  };
}
