/**
 * Headless offscreen renderer.
 *
 * A Node host has no `OffscreenCanvas`, and shipping a native WebGL stack is not an option for a
 * pure-JavaScript package. This renderer therefore keeps the surface contract but delegates the
 * context to the embedder:
 *
 * ```ts
 * import gl from 'gl';
 *
 * const renderer = createOffscreenRenderer({
 *   createContext: (canvas) => gl(canvas.width, canvas.height),
 * });
 * ```
 *
 * Without a backend the simulation still runs headlessly — cameras simply cannot produce frames,
 * so `getContext()` throws {@link OffscreenRenderingUnavailableError} while `readPixels()` returns
 * a zeroed (transparent) buffer, which keeps frame transport code exercised in Node tests.
 */

import {
  assertSurfaceSize,
  createPixelBuffer,
  OffscreenRendererDisposedError,
  OffscreenRenderingUnavailableError,
} from './renderer';
import type { OffscreenRenderer, OffscreenSurface, WebGL2LikeContext } from './renderer';

/** Canvas shim handed to {@link HeadlessRendererOptions.createContext}. */
export interface HeadlessCanvas {
  width: number;
  height: number;
}

/** Options of the headless renderer. */
export interface HeadlessRendererOptions {
  /**
   * Creates a WebGL2 context for a surface, or returns `null` when the backend cannot provide
   * one. Omit it to run without GPU rendering at all.
   */
  readonly createContext?: (canvas: HeadlessCanvas) => WebGL2LikeContext | null;
}

/** Creates a headless renderer; every surface shares the configured context factory. */
export function createOffscreenRenderer(options: HeadlessRendererOptions = {}): OffscreenRenderer {
  const surfaces: HeadlessSurface[] = [];
  let disposed = false;

  return {
    createSurface(width: number, height: number) {
      if (disposed) {
        throw new OffscreenRendererDisposedError('HeadlessRenderer.createSurface: disposed');
      }
      const surface = new HeadlessSurface(width, height, options.createContext);
      surfaces.push(surface);
      return surface;
    },
    dispose() {
      disposed = true;
      for (const surface of surfaces) surface.dispose();
      surfaces.length = 0;
    },
  };
}

class HeadlessSurface implements OffscreenSurface {
  private readonly canvas: HeadlessCanvas;
  private context: WebGL2LikeContext | null = null;
  private closed = false;
  private attempted = false;

  public constructor(
    public width: number,
    public height: number,
    private readonly createContext:
      ((canvas: HeadlessCanvas) => WebGL2LikeContext | null) | undefined,
  ) {
    assertSurfaceSize(width, height);
    this.canvas = { width, height };
  }

  public getContext(): WebGL2LikeContext {
    this.assertUsable('getContext');
    if (!this.attempted) {
      this.attempted = true;
      this.context = this.createContext?.(this.canvas) ?? null;
    }
    if (this.context === null) {
      throw new OffscreenRenderingUnavailableError(
        'HeadlessSurface.getContext: no WebGL2 backend is installed. ' +
          'Pass `createContext` (for example a headless-gl factory) to createOffscreenRenderer().',
      );
    }
    return this.context;
  }

  public readPixels(): Uint8ClampedArray {
    this.assertUsable('readPixels');
    const buffer = createPixelBuffer(this.width, this.height);
    if (this.context !== null) {
      this.context.readPixels(
        0,
        0,
        this.width,
        this.height,
        this.context.RGBA,
        this.context.UNSIGNED_BYTE,
        buffer,
      );
    }
    return buffer;
  }

  public resize(width: number, height: number): void {
    this.assertUsable('resize');
    assertSurfaceSize(width, height);
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  public dispose(): void {
    this.closed = true;
    this.context = null;
  }

  private assertUsable(action: string): void {
    if (this.closed) {
      throw new OffscreenRendererDisposedError(`HeadlessSurface.${action}: disposed`);
    }
  }
}
