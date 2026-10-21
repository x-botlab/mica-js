import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWPORT_LIMITS,
  fitBounds,
  panBy,
  pageToScreen,
  resolveViewportLimits,
  screenToPage,
  zoomAt,
} from './viewport';

describe('viewport', () => {
  const viewport = { scale: 2, offsetX: 100, offsetY: 50 };

  it('converts between page and screen coordinates', () => {
    expect(pageToScreen(viewport, { x: 10, y: 20 })).toEqual({ x: 120, y: 90 });
    expect(screenToPage(viewport, { x: 120, y: 90 })).toEqual({ x: 10, y: 20 });
  });

  it('keeps the anchor point fixed while zooming', () => {
    const anchor = { x: 250, y: 160 };
    const before = screenToPage(viewport, anchor);
    const zoomed = zoomAt(viewport, anchor, 1.5);
    const after = screenToPage(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomed.scale).toBeCloseTo(3);
  });

  it('clamps zoom to the configured limits', () => {
    expect(zoomAt(viewport, { x: 0, y: 0 }, 100).scale).toBe(DEFAULT_VIEWPORT_LIMITS.maxScale);
    expect(zoomAt(viewport, { x: 0, y: 0 }, 0.001).scale).toBe(DEFAULT_VIEWPORT_LIMITS.minScale);
  });

  it('returns the same viewport when the scale cannot change', () => {
    const atMax = { scale: DEFAULT_VIEWPORT_LIMITS.maxScale, offsetX: 0, offsetY: 0 };
    expect(zoomAt(atMax, { x: 10, y: 10 }, 2)).toBe(atMax);
  });

  it('pans by a screen delta', () => {
    expect(panBy(viewport, 10, -5)).toEqual({ scale: 2, offsetX: 110, offsetY: 45 });
  });

  it('fits bounds inside the viewport with padding', () => {
    const fitted = fitBounds(
      { x: 0, y: 0, width: 100, height: 50 },
      { width: 400, height: 300 },
      20,
    );
    expect(fitted.scale).toBeCloseTo(3.6);
    expect(pageToScreen(fitted, { x: 50, y: 25 })).toEqual({ x: 200, y: 150 });
    expect(pageToScreen(fitted, { x: 0, y: 0 }).x).toBeCloseTo(20);
  });

  it('clamps fitted scale for degenerate bounds', () => {
    const fitted = fitBounds({ x: 5, y: 5, width: 0, height: 0 }, { width: 100, height: 100 });
    expect(fitted.scale).toBeLessThanOrEqual(DEFAULT_VIEWPORT_LIMITS.maxScale);
    expect(Number.isFinite(fitted.offsetX)).toBe(true);
  });

  it('merges partial limits onto the defaults', () => {
    expect(resolveViewportLimits()).toEqual(DEFAULT_VIEWPORT_LIMITS);
    expect(resolveViewportLimits({ maxScale: 2 })).toEqual({
      minScale: DEFAULT_VIEWPORT_LIMITS.minScale,
      maxScale: 2,
    });
  });

  it('rejects nonsensical limits', () => {
    expect(resolveViewportLimits({ minScale: 0, maxScale: -1 })).toEqual(DEFAULT_VIEWPORT_LIMITS);
    expect(resolveViewportLimits({ minScale: Number.NaN })).toEqual(DEFAULT_VIEWPORT_LIMITS);
    expect(resolveViewportLimits({ minScale: 4, maxScale: 0.5 })).toEqual({
      minScale: 0.5,
      maxScale: 4,
    });
  });

  it('honours custom limits when zooming', () => {
    const limits = { minScale: 0.5, maxScale: 2 };
    expect(zoomAt(viewport, { x: 0, y: 0 }, 100, limits).scale).toBe(2);
    expect(zoomAt(viewport, { x: 0, y: 0 }, 0.0001, limits).scale).toBe(0.5);
  });
});
