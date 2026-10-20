import type { Point, Rect } from '@mica/core/schematic';

export interface ViewportState {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface ViewportLimits {
  readonly minScale: number;
  readonly maxScale: number;
}

export const DEFAULT_VIEWPORT_LIMITS: ViewportLimits = { minScale: 0.1, maxScale: 8 };

export const IDENTITY_VIEWPORT: ViewportState = { scale: 1, offsetX: 0, offsetY: 0 };

export function screenToPage(viewport: ViewportState, point: Point): Point {
  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (point.y - viewport.offsetY) / viewport.scale,
  };
}

export function pageToScreen(viewport: ViewportState, point: Point): Point {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY,
  };
}

export function clampScale(
  scale: number,
  limits: ViewportLimits = DEFAULT_VIEWPORT_LIMITS,
): number {
  return Math.min(limits.maxScale, Math.max(limits.minScale, scale));
}

/** Zooms around a screen-space point so the page point under the cursor stays fixed. */
export function zoomAt(
  viewport: ViewportState,
  screenPoint: Point,
  factor: number,
  limits: ViewportLimits = DEFAULT_VIEWPORT_LIMITS,
): ViewportState {
  const scale = clampScale(viewport.scale * factor, limits);
  if (scale === viewport.scale) {
    return viewport;
  }
  const anchor = screenToPage(viewport, screenPoint);
  return {
    scale,
    offsetX: screenPoint.x - anchor.x * scale,
    offsetY: screenPoint.y - anchor.y * scale,
  };
}

export function panBy(viewport: ViewportState, dx: number, dy: number): ViewportState {
  return { ...viewport, offsetX: viewport.offsetX + dx, offsetY: viewport.offsetY + dy };
}

/** Fits `bounds` into `size` with padding, centering the content. */
export function fitBounds(
  bounds: Rect,
  size: { readonly width: number; readonly height: number },
  padding = 32,
  limits: ViewportLimits = DEFAULT_VIEWPORT_LIMITS,
): ViewportState {
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const width = Math.max(bounds.width, 1e-6);
  const height = Math.max(bounds.height, 1e-6);
  const scale = clampScale(Math.min(availableWidth / width, availableHeight / height), limits);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return {
    scale,
    offsetX: size.width / 2 - centerX * scale,
    offsetY: size.height / 2 - centerY * scale,
  };
}
