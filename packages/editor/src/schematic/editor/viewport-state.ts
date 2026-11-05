import type { Point, Rect } from '@mica-js/document/schematic';
import {
  DEFAULT_VIEWPORT_LIMITS,
  IDENTITY_VIEWPORT,
  fitBounds,
  panBy,
  resolveViewportLimits,
  zoomAt,
  type IViewportLimits,
  type IViewportState,
} from '../render/viewport';

/**
 * Owns the viewport and the "auto fit until the user takes over" rule.
 * An empty canvas keeps refitting while the container resizes.
 */
export class EditorViewport {
  #state: IViewportState = IDENTITY_VIEWPORT;
  #autoFit = true;
  readonly #limits: IViewportLimits;

  constructor(limits: IViewportLimits = DEFAULT_VIEWPORT_LIMITS) {
    this.#limits = resolveViewportLimits(limits);
  }

  get state(): IViewportState {
    return this.#state;
  }

  get limits(): IViewportLimits {
    return this.#limits;
  }

  get autoFit(): boolean {
    return this.#autoFit;
  }

  /** Fits `bounds` into the given viewport size and re-enables auto fit. */
  fit(bounds: Rect | undefined, size: { readonly width: number; readonly height: number }): void {
    if (size.width === 0 || size.height === 0) {
      return;
    }
    this.#state = fitBounds(
      bounds ?? { x: -50, y: -50, width: 100, height: 100 },
      size,
      48,
      this.#limits,
    );
    this.#autoFit = true;
  }

  pan(dx: number, dy: number): void {
    this.#autoFit = false;
    this.#state = panBy(this.#state, dx, dy);
  }

  zoomAt(screenPoint: Point, factor: number): void {
    this.#autoFit = false;
    this.#state = zoomAt(this.#state, screenPoint, factor, this.#limits);
  }

  zoomTo(scale: number, center: Point): void {
    if (scale <= 0 || !Number.isFinite(scale)) {
      return;
    }
    this.#autoFit = false;
    this.#state = zoomAt(this.#state, center, scale / this.#state.scale, this.#limits);
  }

  /** Restores a saved viewport (already clamped by the caller); turns auto fit off. */
  setState(state: IViewportState): void {
    this.#autoFit = false;
    this.#state = state;
  }

  /** Turns off auto fit when the user interacts with the view. */
  takeOver(): void {
    this.#autoFit = false;
  }
}
