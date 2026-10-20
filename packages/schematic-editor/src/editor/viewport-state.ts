import type { Point, Rect } from '@mica/core/schematic';
import {
  IDENTITY_VIEWPORT,
  fitBounds,
  panBy,
  zoomAt,
  type ViewportState,
} from '../render/viewport';

/**
 * Owns the viewport and the "auto fit until the user takes over" rule.
 * An empty canvas keeps refitting while the container resizes.
 */
export class EditorViewport {
  #state: ViewportState = IDENTITY_VIEWPORT;
  #autoFit = true;

  get state(): ViewportState {
    return this.#state;
  }

  get autoFit(): boolean {
    return this.#autoFit;
  }

  /** Fits `bounds` into the given viewport size and re-enables auto fit. */
  fit(bounds: Rect | undefined, size: { readonly width: number; readonly height: number }): void {
    if (size.width === 0 || size.height === 0) {
      return;
    }
    this.#state = fitBounds(bounds ?? { x: -50, y: -50, width: 100, height: 100 }, size, 48);
    this.#autoFit = true;
  }

  pan(dx: number, dy: number): void {
    this.#autoFit = false;
    this.#state = panBy(this.#state, dx, dy);
  }

  zoomAt(screenPoint: Point, factor: number): void {
    this.#autoFit = false;
    this.#state = zoomAt(this.#state, screenPoint, factor);
  }

  zoomTo(scale: number, center: Point): void {
    if (scale <= 0 || !Number.isFinite(scale)) {
      return;
    }
    this.#autoFit = false;
    this.#state = zoomAt(this.#state, center, scale / this.#state.scale);
  }

  /** Turns off auto fit when the user interacts with the view. */
  takeOver(): void {
    this.#autoFit = false;
  }
}
