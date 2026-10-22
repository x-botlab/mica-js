import { describe, expect, it } from 'vitest';
import {
  MAX_VIEWPORT_SCALE,
  MIN_VIEWPORT_SCALE,
  clampScale,
  documentToScreen,
  panBy,
  screenToDocument,
  zoomAt,
  zoomTo,
} from './viewport';

describe('viewport', () => {
  const viewport = { x: 100, y: 50, scale: 2 };

  it('converts between document and screen coordinates', () => {
    expect(documentToScreen(viewport, { x: 10, y: 20 })).toEqual({ x: 120, y: 90 });
    expect(screenToDocument(viewport, { x: 120, y: 90 })).toEqual({ x: 10, y: 20 });
  });

  it('keeps the anchor point fixed while zooming', () => {
    const anchor = { x: 250, y: 160 };
    const before = screenToDocument(viewport, anchor);
    const zoomed = zoomAt(viewport, anchor, 1.5);
    const after = screenToDocument(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomed.scale).toBeCloseTo(3);
  });

  it('clamps the scale to the supported range', () => {
    expect(zoomAt(viewport, { x: 0, y: 0 }, 1000).scale).toBe(MAX_VIEWPORT_SCALE);
    expect(zoomAt(viewport, { x: 0, y: 0 }, 0.0001).scale).toBe(MIN_VIEWPORT_SCALE);
    expect(clampScale(Number.NaN)).toBe(MIN_VIEWPORT_SCALE);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MAX_VIEWPORT_SCALE);
    expect(clampScale(-4)).toBe(MIN_VIEWPORT_SCALE);
    expect(clampScale(1)).toBe(1);
  });

  it('returns the same viewport when the scale cannot change', () => {
    const atMax = { x: 0, y: 0, scale: MAX_VIEWPORT_SCALE };
    expect(zoomAt(atMax, { x: 10, y: 10 }, 2)).toBe(atMax);
    expect(zoomTo(atMax, { x: 10, y: 10 }, MAX_VIEWPORT_SCALE * 2)).toBe(atMax);
  });

  it('zooms to an absolute scale around a screen point', () => {
    const zoomed = zoomTo(viewport, { x: 120, y: 90 }, 4);
    expect(zoomed.scale).toBe(4);
    expect(screenToDocument(zoomed, { x: 120, y: 90 })).toEqual({ x: 10, y: 20 });
  });

  it('ignores a non-finite or non-positive factor', () => {
    expect(zoomAt(viewport, { x: 0, y: 0 }, Number.NaN)).toBe(viewport);
    expect(zoomAt(viewport, { x: 0, y: 0 }, 0)).toBe(viewport);
  });

  it('pans by a screen delta', () => {
    expect(panBy(viewport, 10, -5)).toEqual({ x: 110, y: 45, scale: 2 });
  });
});
