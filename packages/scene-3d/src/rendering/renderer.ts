/**
 * Environment-neutral offscreen rendering contract.
 *
 * A `Scene3DHost` runs inside a sandbox Worker, so it cannot touch a DOM canvas. Camera sensors
 * (#192) therefore render into an offscreen surface produced by an {@link OffscreenRenderer}, and
 * the *environment* decides how that surface is backed:
 *
 * - `renderer.browser.ts` uses `OffscreenCanvas` + WebGL2 inside a browser Worker;
 * - `renderer.headless.ts` runs without a GPU and lets the embedder plug in `headless-gl`;
 * - `renderer.mock.ts` is a deterministic in-memory surface for tests.
 *
 * The core never branches on the environment: the guest runtime selects the browser renderer while tests inject headless implementations
 * `Scene3DHostOptions.renderer`.
 *
 * ```ts
 * const renderer = createOffscreenRenderer();
 * const surface = renderer.createSurface(640, 480);
 * const gl = surface.getContext();
 * // … a Three.js renderer draws into `gl` …
 * const rgba = surface.readPixels();
 * ```
 */

/** Bytes per pixel of the RGBA surfaces this contract produces. */
export const PIXEL_CHANNELS = 4;

/**
 * Minimal WebGL2 surface used by the host.
 *
 * The interface only declares what the simulation itself needs — creating a surface, clearing it
 * and reading the result back. A renderer adapter (Three.js) receives the concrete context from
 * {@link OffscreenSurface.getContext}; implementations return the real `WebGL2RenderingContext`
 * behind a cast, because mirroring the entire WebGL2 API here would add no safety.
 */
export interface WebGL2LikeContext {
  /** Canvas the context draws into; its size follows {@link OffscreenSurface.resize}. */
  readonly canvas: { readonly width: number; readonly height: number };

  viewport(x: number, y: number, width: number, height: number): void;
  clear(mask: number): void;
  clearColor(red: number, green: number, blue: number, alpha: number): void;
  readPixels(
    x: number,
    y: number,
    width: number,
    height: number,
    format: number,
    type: number,
    pixels: ArrayBufferView,
  ): void;

  /** Buffers cleared by `clear()`; same value as `WebGL2RenderingContext.COLOR_BUFFER_BIT`. */
  readonly COLOR_BUFFER_BIT: number;
  /** Buffers cleared by `clear()`; same value as `WebGL2RenderingContext.DEPTH_BUFFER_BIT`. */
  readonly DEPTH_BUFFER_BIT: number;
  /** Read-back format of {@link OffscreenSurface.readPixels}. */
  readonly RGBA: number;
  /** Read-back type of {@link OffscreenSurface.readPixels}. */
  readonly UNSIGNED_BYTE: number;
}

/** Off-screen render target owned by the host. */
export interface OffscreenSurface {
  /** Surface width in device pixels. */
  readonly width: number;
  /** Surface height in device pixels. */
  readonly height: number;

  /**
   * Returns the WebGL2-compatible context of this surface, creating it on first use.
   *
   * Throws when the environment cannot provide one, for example a headless renderer without a
   * `headless-gl` backend.
   */
  getContext(): WebGL2LikeContext;

  /**
   * Copies the current framebuffer into a new RGBA buffer.
   *
   * @returns `width * height * 4` bytes in row-major order, starting at the bottom-left corner as
   * WebGL does.
   */
  readPixels(): Uint8ClampedArray;

  /** Resizes the drawing buffer; the next {@link OffscreenSurface.getContext} call reflects it. */
  resize(width: number, height: number): void;

  /** Releases the surface; further use throws. */
  dispose(): void;
}

/** Factory of offscreen surfaces; one instance is shared by every camera sensor of a host. */
export interface OffscreenRenderer {
  /** Creates a surface; throws when the renderer was disposed. */
  createSurface(width: number, height: number): OffscreenSurface;

  /** Releases every surface this renderer created; idempotent. */
  dispose(): void;
}

/** Thrown when a renderer or surface is used after {@link OffscreenSurface.dispose}. */
export class OffscreenRendererDisposedError extends Error {
  public constructor(message = 'Offscreen renderer has been disposed') {
    super(message);
    this.name = 'OffscreenRendererDisposedError';
  }
}

/** Thrown when the current environment cannot provide a WebGL2 surface. */
export class OffscreenRenderingUnavailableError extends Error {
  public constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'OffscreenRenderingUnavailableError';
  }
}

/** Throws unless `width`/`height` are positive integers. Shared by every implementation. */
export function assertSurfaceSize(width: number, height: number): void {
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(
      `OffscreenSurface: width must be a positive integer, got ${String(width)}`,
    );
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError(
      `OffscreenSurface: height must be a positive integer, got ${String(height)}`,
    );
  }
}

/** Allocates a zeroed RGBA buffer for a surface of the given size. */
export function createPixelBuffer(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * PIXEL_CHANNELS);
}
