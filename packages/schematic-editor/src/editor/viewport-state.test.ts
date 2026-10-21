import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEWPORT_LIMITS } from '../render/viewport';
import { EditorViewport } from './viewport-state';

describe('EditorViewport', () => {
  it('starts at identity with auto fit on', () => {
    const viewport = new EditorViewport();
    expect(viewport.state).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(viewport.autoFit).toBe(true);
    expect(viewport.limits).toEqual(DEFAULT_VIEWPORT_LIMITS);
  });

  it('clamps wheel zoom to the limits', () => {
    const viewport = new EditorViewport();
    for (let step = 0; step < 100; step += 1) {
      viewport.zoomAt({ x: 0, y: 0 }, 1.1);
    }
    expect(viewport.state.scale).toBe(DEFAULT_VIEWPORT_LIMITS.maxScale);
    for (let step = 0; step < 200; step += 1) {
      viewport.zoomAt({ x: 0, y: 0 }, 1 / 1.1);
    }
    expect(viewport.state.scale).toBe(DEFAULT_VIEWPORT_LIMITS.minScale);
    expect(viewport.autoFit).toBe(false);
  });

  it('clamps zoomTo requests', () => {
    const viewport = new EditorViewport();
    viewport.zoomTo(100, { x: 0, y: 0 });
    expect(viewport.state.scale).toBe(DEFAULT_VIEWPORT_LIMITS.maxScale);
    viewport.zoomTo(0.01, { x: 0, y: 0 });
    expect(viewport.state.scale).toBe(DEFAULT_VIEWPORT_LIMITS.minScale);
  });

  it('uses the configured limits for wheel, fit and zoomTo', () => {
    const viewport = new EditorViewport({ minScale: 0.5, maxScale: 2 });
    viewport.zoomTo(50, { x: 0, y: 0 });
    expect(viewport.state.scale).toBe(2);
    viewport.fit({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 1000 });
    expect(viewport.state.scale).toBe(2);
    expect(viewport.autoFit).toBe(true);
  });

  it('ignores zoomTo requests that are not positive numbers', () => {
    const viewport = new EditorViewport();
    viewport.zoomTo(0, { x: 0, y: 0 });
    viewport.zoomTo(Number.NaN, { x: 0, y: 0 });
    expect(viewport.state.scale).toBe(1);
  });
});
