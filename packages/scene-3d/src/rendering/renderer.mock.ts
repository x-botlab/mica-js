/**
 * Deterministic offscreen renderer for tests.
 *
 * The mock never touches a GPU: every surface keeps a plain RGBA buffer that `readPixels()`
 * returns, so tests can assert on sizes, lifecycle and pixel transport without a browser or a
 * native `headless-gl` build. The framebuffer is a fixed colour — by default opaque black — which
 * is enough to verify that camera frames reach the caller (#192).
 */

import { assertSurfaceSize, createPixelBuffer, OffscreenRendererDisposedError } from './renderer';
import type { OffscreenRenderer, OffscreenSurface, WebGL2LikeContext } from './renderer';

/** RGBA colour every mock surface returns from `readPixels()`. */
export type MockPixel = readonly [red: number, green: number, blue: number, alpha: number];

/** Options of {@link createOffscreenRenderer}. */
export interface MockOffscreenRendererOptions {
  /** Colour of every read pixel; defaults to opaque black `(0, 0, 0, 255)`. */
  readonly pixel?: MockPixel;
}

/** Mock surface that also exposes its lifecycle for assertions. */
export interface MockOffscreenSurface extends OffscreenSurface {
  /** Whether {@link MockOffscreenSurface.dispose} has run. */
  readonly disposed: boolean;
  /** Number of {@link MockOffscreenSurface.readPixels} calls; useful for frame assertions. */
  readonly readCount: number;
}

/** Mock renderer that also exposes the surfaces it created for assertions. */
export interface MockOffscreenRenderer extends OffscreenRenderer {
  /** Every surface created so far, in creation order, including disposed ones. */
  readonly surfaces: readonly MockOffscreenSurface[];
  /** Whether {@link MockOffscreenRenderer.dispose} has run. */
  readonly disposed: boolean;
  /** Creates a mock surface (same contract as {@link OffscreenRenderer.createSurface}). */
  createSurface(width: number, height: number): MockOffscreenSurface;
}

const DEFAULT_PIXEL: MockPixel = [0, 0, 0, 255];

/** Creates a mock renderer; pass a disposal-sensitive pixel colour when a test needs one. */
export function createOffscreenRenderer(
  options: MockOffscreenRendererOptions = {},
): MockOffscreenRenderer {
  const pixel = options.pixel ?? DEFAULT_PIXEL;
  const surfaces: MockOffscreenSurface[] = [];
  let disposed = false;

  return {
    surfaces,
    get disposed() {
      return disposed;
    },
    createSurface(width: number, height: number) {
      if (disposed) {
        throw new OffscreenRendererDisposedError('MockOffscreenRenderer.createSurface: disposed');
      }
      const surface = new MockSurface(width, height, pixel);
      surfaces.push(surface);
      return surface;
    },
    dispose() {
      disposed = true;
      for (const surface of surfaces) surface.dispose();
    },
  };
}

class MockSurface implements MockOffscreenSurface {
  public readCount = 0;
  private closed = false;
  private canvas: { width: number; height: number };
  private context: MockContext;

  public constructor(
    public width: number,
    public height: number,
    private readonly pixel: MockPixel,
  ) {
    assertSurfaceSize(width, height);
    this.canvas = { width, height };
    this.context = new MockContext(this.canvas);
  }

  public get disposed(): boolean {
    return this.closed;
  }

  public getContext(): WebGL2LikeContext {
    this.assertUsable('getContext');
    return this.context;
  }

  public readPixels(): Uint8ClampedArray {
    this.assertUsable('readPixels');
    this.readCount++;
    const buffer = createPixelBuffer(this.width, this.height);
    const [red, green, blue, alpha] = this.pixel;
    for (let offset = 0; offset < buffer.length; offset += 4) {
      buffer[offset] = red;
      buffer[offset + 1] = green;
      buffer[offset + 2] = blue;
      buffer[offset + 3] = alpha;
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
  }

  private assertUsable(action: string): void {
    if (this.closed) {
      throw new OffscreenRendererDisposedError(`MockOffscreenSurface.${action}: disposed`);
    }
  }
}

/** Records the handful of WebGL2 calls the host itself makes. */
class MockContext implements WebGL2LikeContext {
  public readonly COLOR_BUFFER_BIT = 0x4000;
  public readonly DEPTH_BUFFER_BIT = 0x0100;
  public readonly RGBA = 0x1908;
  public readonly UNSIGNED_BYTE = 0x1401;
  public readonly calls: string[] = [];
  public readonly clearColors: MockPixel[] = [];

  public constructor(public readonly canvas: { readonly width: number; readonly height: number }) {}

  public viewport(x: number, y: number, width: number, height: number): void {
    this.calls.push(`viewport(${x}, ${y}, ${width}, ${height})`);
  }

  public clear(mask: number): void {
    this.calls.push(`clear(${mask})`);
  }

  public clearColor(red: number, green: number, blue: number, alpha: number): void {
    this.calls.push(`clearColor(${red}, ${green}, ${blue}, ${alpha})`);
    this.clearColors.push([red, green, blue, alpha]);
  }

  public readPixels(): void {
    this.calls.push('readPixels()');
  }
}
