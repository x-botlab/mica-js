import { describe, expect, it } from 'vitest';
import { OffscreenRendererDisposedError, OffscreenRenderingUnavailableError } from './renderer';
import type { WebGL2LikeContext } from './renderer';
import { createOffscreenRenderer as createHeadlessRenderer } from './renderer.headless';
import { createOffscreenRenderer as createMockRenderer } from './renderer.mock';

describe('mock offscreen renderer', () => {
  it('creates a surface with the requested size and a matching context canvas', () => {
    const renderer = createMockRenderer();
    const surface = renderer.createSurface(64, 32);

    expect(surface.width).toBe(64);
    expect(surface.height).toBe(32);
    expect(surface.getContext().canvas).toEqual({ width: 64, height: 32 });
    expect(renderer.surfaces).toHaveLength(1);
  });

  it('returns an RGBA buffer of width * height * 4 bytes', () => {
    const renderer = createMockRenderer();
    const surface = renderer.createSurface(3, 2);

    const pixels = surface.readPixels();

    expect(pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(pixels).toHaveLength(3 * 2 * 4);
  });

  it('returns opaque black by default and honours a custom pixel', () => {
    const black = createMockRenderer().createSurface(1, 1).readPixels();
    expect([...black]).toEqual([0, 0, 0, 255]);

    const red = createMockRenderer({ pixel: [255, 0, 0, 128] })
      .createSurface(2, 1)
      .readPixels();
    expect([...red]).toEqual([255, 0, 0, 128, 255, 0, 0, 128]);
  });

  it('resizes the buffer and the context canvas', () => {
    const renderer = createMockRenderer();
    const surface = renderer.createSurface(2, 2);
    const context = surface.getContext();

    surface.resize(4, 3);

    expect(surface.width).toBe(4);
    expect(surface.height).toBe(3);
    expect(context.canvas).toEqual({ width: 4, height: 3 });
    expect(surface.readPixels()).toHaveLength(4 * 3 * 4);
  });

  it('counts reads so tests can assert on frame transport', () => {
    const renderer = createMockRenderer();
    const surface = renderer.createSurface(1, 1);

    surface.readPixels();
    surface.readPixels();

    expect(surface.readCount).toBe(2);
  });

  it('disposes every surface and rejects later use', () => {
    const renderer = createMockRenderer();
    const first = renderer.createSurface(4, 4);
    const second = renderer.createSurface(8, 8);

    renderer.dispose();

    expect(renderer.disposed).toBe(true);
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(true);
    expect(() => first.readPixels()).toThrow(OffscreenRendererDisposedError);
    expect(() => first.getContext()).toThrow(OffscreenRendererDisposedError);
    expect(() => first.resize(2, 2)).toThrow(OffscreenRendererDisposedError);
    expect(() => renderer.createSurface(1, 1)).toThrow(OffscreenRendererDisposedError);
  });

  it('is idempotent when disposed twice', () => {
    const renderer = createMockRenderer();
    renderer.createSurface(1, 1);

    renderer.dispose();
    expect(() => renderer.dispose()).not.toThrow();
  });

  it('rejects invalid surface sizes', () => {
    const renderer = createMockRenderer();

    expect(() => renderer.createSurface(0, 10)).toThrow(RangeError);
    expect(() => renderer.createSurface(10, -1)).toThrow(RangeError);
    expect(() => renderer.createSurface(1.5, 10)).toThrow(RangeError);
  });
});

describe('headless offscreen renderer', () => {
  it('runs without a GPU and reports that context creation is unavailable', () => {
    const renderer = createHeadlessRenderer();
    const surface = renderer.createSurface(2, 2);

    expect(() => surface.getContext()).toThrow(OffscreenRenderingUnavailableError);
    expect([...surface.readPixels()]).toEqual(new Array(2 * 2 * 4).fill(0));
  });

  it('delegates readPixels to the injected context', () => {
    const context = createFakeContext();
    const renderer = createHeadlessRenderer({ createContext: () => context });
    const surface = renderer.createSurface(2, 1);

    expect(surface.getContext()).toBe(context);
    const pixels = surface.readPixels();

    expect(pixels).toHaveLength(8);
    expect([...pixels.slice(0, 4)]).toEqual([7, 7, 7, 7]);
    expect(context.readPixelsCalls).toEqual(['0,0,2,1']);
  });

  it('creates the context once and keeps the canvas it was given live', () => {
    let calls = 0;
    let factoryCanvas: { width: number; height: number } | undefined;
    const renderer = createHeadlessRenderer({
      createContext: (canvas) => {
        calls++;
        factoryCanvas = canvas;
        return createFakeContext();
      },
    });
    const surface = renderer.createSurface(2, 2);

    surface.getContext();
    surface.getContext();
    expect(calls).toBe(1);

    surface.resize(5, 4);
    surface.getContext();
    expect(calls).toBe(1);
    expect(factoryCanvas).toEqual({ width: 5, height: 4 });
  });

  it('reports a null factory result as unavailable', () => {
    const renderer = createHeadlessRenderer({ createContext: () => null });

    expect(() => renderer.createSurface(1, 1).getContext()).toThrow(
      OffscreenRenderingUnavailableError,
    );
  });

  it('disposes its surfaces', () => {
    const renderer = createHeadlessRenderer({ createContext: () => createFakeContext() });
    const surface = renderer.createSurface(1, 1);

    renderer.dispose();

    expect(() => surface.getContext()).toThrow(OffscreenRendererDisposedError);
    expect(() => surface.readPixels()).toThrow(OffscreenRendererDisposedError);
    expect(() => renderer.createSurface(1, 1)).toThrow(OffscreenRendererDisposedError);
  });
});

interface FakeContext extends WebGL2LikeContext {
  readonly readPixelsCalls: string[];
}

function createFakeContext(): FakeContext {
  const canvas = { width: 1, height: 1 };
  const readPixelsCalls: string[] = [];
  return {
    canvas,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    readPixelsCalls,
    viewport() {},
    clear() {},
    clearColor() {},
    readPixels(x, y, width, height, _format, _type, pixels) {
      readPixelsCalls.push(`${x},${y},${width},${height}`);
      if (pixels instanceof Uint8ClampedArray) pixels.fill(7);
    },
  };
}
