/**
 * Browser offscreen renderer.
 *
 * Runs inside a sandbox Worker, where there is no DOM but `OffscreenCanvas` and WebGL2 are
 * available. The drawing buffer is preserved so camera sensors can read a frame after Three.js
 * has drawn into it.
 */

import {
  assertSurfaceSize,
  createPixelBuffer,
  OffscreenRendererDisposedError,
  OffscreenRenderingUnavailableError,
} from './renderer';
import type { OffscreenRenderer, OffscreenSurface, WebGL2LikeContext } from './renderer';

/** WebGL2 context attributes tuned for a renderer that is read back once per frame. */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: true,
  depth: true,
  preserveDrawingBuffer: true,
  premultipliedAlpha: true,
};

/** Creates an `OffscreenCanvas`-backed renderer. */
export function createOffscreenRenderer(): OffscreenRenderer {
  const surfaces: BrowserSurface[] = [];
  let disposed = false;

  return {
    createSurface(width: number, height: number) {
      if (disposed) {
        throw new OffscreenRendererDisposedError('BrowserRenderer.createSurface: disposed');
      }
      const surface = new BrowserSurface(width, height);
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

class BrowserSurface implements OffscreenSurface {
  private readonly canvas: OffscreenCanvas;
  private gl: WebGL2RenderingContext | null = null;
  private closed = false;

  public constructor(
    public width: number,
    public height: number,
  ) {
    assertSurfaceSize(width, height);
    if (typeof OffscreenCanvas === 'undefined') {
      throw new OffscreenRenderingUnavailableError(
        'BrowserRenderer: OffscreenCanvas is not available in this environment',
      );
    }
    this.canvas = new OffscreenCanvas(width, height);
  }

  public getContext(): WebGL2LikeContext {
    this.assertUsable('getContext');
    if (this.gl === null) {
      const gl = this.canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
      if (gl === null) {
        throw new OffscreenRenderingUnavailableError(
          'BrowserRenderer: the offscreen canvas could not create a WebGL2 context',
        );
      }
      this.gl = gl;
    }
    return this.gl as unknown as WebGL2LikeContext;
  }

  public readPixels(): Uint8ClampedArray {
    this.assertUsable('readPixels');
    const gl = this.gl;
    const pixels = createPixelBuffer(this.width, this.height);
    if (gl === null) {
      // The surface was never drawn into; report a transparent frame rather than throwing, so a
      // host can still batch camera output before the first render.
      return pixels;
    }
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  public resize(width: number, height: number): void {
    this.assertUsable('resize');
    assertSurfaceSize(width, height);
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    // Resizing the drawing buffer resets the WebGL viewport.
    this.gl?.viewport(0, 0, width, height);
  }

  public dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
  }

  private assertUsable(action: string): void {
    if (this.closed) {
      throw new OffscreenRendererDisposedError(`BrowserSurface.${action}: disposed`);
    }
  }
}
