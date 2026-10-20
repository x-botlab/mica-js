import type { SurfaceGeometry } from '../protocol';

export interface FramePresenterOptions {
  canvas?: HTMLCanvasElement | undefined;
  maxFps: number;
  onFrame?: ((bitmap: ImageBitmap, geometry: SurfaceGeometry) => void) | undefined;
}

/**
 * Composites guest frames onto the host canvas. A visible canvas can never be handed to the
 * sandbox (transferring an `OffscreenCanvas` into an opaque-origin iframe crashes the renderer),
 * so the guest renders in its own worker canvas and this class only blits the result.
 */
export class FramePresenter {
  readonly #canvas: HTMLCanvasElement | undefined;
  readonly #maxFps: number;
  readonly #onFrame: FramePresenterOptions['onFrame'];
  #bitmapRenderer: ImageBitmapRenderingContext | null = null;
  #context2d: CanvasRenderingContext2D | null = null;
  #lastFrameAt = 0;
  #disposed = false;

  constructor(options: FramePresenterOptions) {
    this.#canvas = options.canvas;
    this.#maxFps = options.maxFps;
    this.#onFrame = options.onFrame;
  }

  setGeometry(geometry: SurfaceGeometry): void {
    const canvas = this.#canvas;
    if (!canvas) return;
    if (canvas.width !== geometry.width) canvas.width = geometry.width;
    if (canvas.height !== geometry.height) canvas.height = geometry.height;
  }

  present(bitmap: ImageBitmap, geometry: SurfaceGeometry): void {
    if (this.#disposed || this.#throttled()) {
      closeBitmap(bitmap);
      return;
    }

    this.#lastFrameAt = performance.now();

    if (this.#onFrame) {
      this.#onFrame(bitmap, geometry);
      return;
    }

    if (!this.#canvas) {
      closeBitmap(bitmap);
      return;
    }

    this.setGeometry(geometry);

    const renderer = this.#getBitmapRenderer();
    if (renderer) {
      try {
        // Consumes the bitmap: do not close it afterwards.
        renderer.transferFromImageBitmap(bitmap);
      } catch {
        closeBitmap(bitmap);
      }
      return;
    }

    const context = this.#getContext2d();
    if (context) {
      context.drawImage(bitmap, 0, 0, this.#canvas.width, this.#canvas.height);
    }
    closeBitmap(bitmap);
  }

  dispose(): void {
    this.#disposed = true;
    this.#bitmapRenderer = null;
    this.#context2d = null;
  }

  #throttled(): boolean {
    if (this.#maxFps <= 0) return false;
    return performance.now() - this.#lastFrameAt < 1000 / this.#maxFps;
  }

  #getBitmapRenderer(): ImageBitmapRenderingContext | null {
    if (this.#bitmapRenderer) return this.#bitmapRenderer;
    if (!this.#canvas || this.#context2d) return null;
    try {
      this.#bitmapRenderer = this.#canvas.getContext('bitmaprenderer');
    } catch {
      this.#bitmapRenderer = null;
    }
    return this.#bitmapRenderer;
  }

  #getContext2d(): CanvasRenderingContext2D | null {
    if (this.#context2d) return this.#context2d;
    if (!this.#canvas) return null;
    try {
      this.#context2d = this.#canvas.getContext('2d');
    } catch {
      this.#context2d = null;
    }
    return this.#context2d;
  }
}

function closeBitmap(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch {
    // Already detached.
  }
}
