import type { CanvasDocument, CanvasWidgetInstance, WidgetPlacement } from '@mica-js/core/canvas';
import type { WidgetLayers } from '@mica-js/widget';
import { RESIZE_HANDLES, degreesToRadians, handlePoints, placementCenter } from '../geometry';
import { ROTATE_HANDLE_OFFSET } from '../session';
import type { CanvasTheme } from '../theme';
import type { CanvasEditorDiagnostic, CanvasMode } from '../types';
import { screenToDocument, type ViewportState } from '../viewport';
import { isMajorGridLine, resolveGridStep } from './grid';

/** Screen-space size of a square resize handle. */
const HANDLE_SIZE = 7;
/** Screen-space radius of the round rotation handle. */
const ROTATE_HANDLE_RADIUS = 4;
/** Screen-space width of the per-instance border drawn in edit mode. */
const OUTLINE_WIDTH = 1.5;
/** Dark backing under that border, so it stays readable on a bright widget frame. */
const OUTLINE_HALO = 'rgba(10, 10, 10, 0.35)';

/** Everything one repaint needs; the renderer owns no state beyond the canvas surface. */
export interface CanvasFrame {
  readonly document: CanvasDocument;
  readonly layers: WidgetLayers;
  /** In-progress geometry of a drag/resize/rotate, drawn instead of the document placement. */
  readonly previews: ReadonlyMap<string, WidgetPlacement>;
  readonly selection: readonly string[];
  readonly viewport: ViewportState;
  readonly mode: CanvasMode;
}

export interface CanvasFrameRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly theme: CanvasTheme;
  readonly onDiagnostic?: (diagnostic: CanvasEditorDiagnostic) => void;
}

/**
 * Draws a {@link CanvasFrame} onto a canvas element.
 *
 * Composite order: grid → widget bitmaps (in `layers.list()` order, placeholders for instances
 * without a frame) → selection outlines → handles. The context is scaled by
 * `devicePixelRatio * scale`, so every coordinate below stays in document units.
 */
export class CanvasFrameRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D | null;
  readonly #theme: CanvasTheme;
  readonly #onDiagnostic: ((diagnostic: CanvasEditorDiagnostic) => void) | undefined;
  #width = 0;
  #height = 0;
  #dpr = 1;

  constructor(options: CanvasFrameRendererOptions) {
    this.#canvas = options.canvas;
    this.#theme = options.theme;
    this.#onDiagnostic = options.onDiagnostic;
    this.#context = options.canvas.getContext('2d');
    if (this.#context === null) {
      this.#report({
        code: 'canvas-editor/context-unavailable',
        message: 'The canvas element did not provide a 2D context.',
      });
    }
  }

  /** Resizes the backing store; `width`/`height` are CSS pixels, `dpr` the device pixel ratio. */
  resize(width: number, height: number, dpr: number): void {
    this.#width = Math.max(1, Math.round(width));
    this.#height = Math.max(1, Math.round(height));
    this.#dpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    this.#canvas.width = Math.round(this.#width * this.#dpr);
    this.#canvas.height = Math.round(this.#height * this.#dpr);
  }

  render(frame: CanvasFrame): void {
    const context = this.#context;
    if (context === null) {
      return;
    }
    const { scale } = frame.viewport;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = this.#theme.background;
    context.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    context.setTransform(
      this.#dpr * scale,
      0,
      0,
      this.#dpr * scale,
      this.#dpr * frame.viewport.x,
      this.#dpr * frame.viewport.y,
    );

    this.#drawGrid(context, frame);
    this.#drawInstances(context, frame);
    if (frame.mode === 'edit') {
      this.#drawOutlines(context, frame);
      this.#drawSelection(context, frame);
    }
  }

  destroy(): void {
    this.#width = 0;
    this.#height = 0;
  }

  #drawGrid(context: CanvasRenderingContext2D, frame: CanvasFrame): void {
    const { viewport } = frame;
    // `theme.gridSize <= 0` is how a host hides the grid; the helper also keeps the step finite, so
    // a degenerate theme can never stall the render loop.
    const step = resolveGridStep(this.#theme.gridSize, viewport.scale);
    if (step === undefined) {
      return;
    }
    const topLeft = screenToDocument(viewport, { x: 0, y: 0 });
    const bottomRight = screenToDocument(viewport, { x: this.#width, y: this.#height });
    const startX = Math.floor(topLeft.x / step) * step;
    const startY = Math.floor(topLeft.y / step) * step;

    const stroke = (major: boolean): void => {
      context.beginPath();
      for (let x = startX; x <= bottomRight.x; x += step) {
        if (isMajorGridLine(x, step) !== major) {
          continue;
        }
        context.moveTo(x, topLeft.y);
        context.lineTo(x, bottomRight.y);
      }
      for (let y = startY; y <= bottomRight.y; y += step) {
        if (isMajorGridLine(y, step) !== major) {
          continue;
        }
        context.moveTo(topLeft.x, y);
        context.lineTo(bottomRight.x, y);
      }
      context.strokeStyle = major ? this.#theme.gridMajor : this.#theme.grid;
      context.lineWidth = 1 / viewport.scale;
      context.stroke();
    };

    stroke(false);
    stroke(true);
  }

  #drawInstances(context: CanvasRenderingContext2D, frame: CanvasFrame): void {
    const drawn = new Set<string>();
    for (const layer of frame.layers.list()) {
      const instance = findInstance(frame.document, layer.instanceId);
      if (instance === undefined) {
        continue;
      }
      drawn.add(instance.id);
      this.#drawInstance(context, frame, instance, layer.bitmap);
    }
    // An instance that has no layer yet still needs a frame, otherwise a canvas whose widgets are
    // still mounting would look empty.
    for (const instance of frame.document.widgets) {
      if (!drawn.has(instance.id)) {
        this.#drawInstance(context, frame, instance, undefined);
      }
    }
  }

  #drawInstance(
    context: CanvasRenderingContext2D,
    frame: CanvasFrame,
    instance: CanvasWidgetInstance,
    bitmap: ImageBitmap | undefined,
  ): void {
    const placement = frame.previews.get(instance.id) ?? instance;
    const { width, height } = placement;
    const center = placementCenter(placement);
    context.save();
    context.translate(center.x, center.y);
    context.rotate(degreesToRadians(placement.rotation));
    if (bitmap === undefined) {
      this.#drawPlaceholder(context, frame, width, height);
    } else {
      try {
        context.drawImage(bitmap, -width / 2, -height / 2, width, height);
      } catch (error) {
        this.#report({
          code: 'canvas-editor/render-failed',
          message: `Could not draw the frame of instance "${instance.id}".`,
          instanceId: instance.id,
          cause: error,
        });
        this.#drawPlaceholder(context, frame, width, height);
      }
    }
    context.restore();
  }

  #drawPlaceholder(
    context: CanvasRenderingContext2D,
    frame: CanvasFrame,
    width: number,
    height: number,
  ): void {
    const lineWidth = 1 / frame.viewport.scale;
    context.fillStyle = this.#theme.placeholderFill;
    context.fillRect(-width / 2, -height / 2, width, height);
    context.strokeStyle = this.#theme.placeholderStroke;
    context.lineWidth = lineWidth;
    context.setLineDash([4 / frame.viewport.scale, 3 / frame.viewport.scale]);
    context.strokeRect(-width / 2, -height / 2, width, height);
    context.setLineDash([]);
  }

  /**
   * A faint border around every instance in edit mode.
   *
   * A widget may paint nothing at all (a fully transparent button over a photo), so the geometry
   * has to be visible without selecting it first. Selection draws its own brighter dashed outline
   * and handles on top of this.
   */
  #drawOutlines(context: CanvasRenderingContext2D, frame: CanvasFrame): void {
    const lineWidth = OUTLINE_WIDTH / frame.viewport.scale;
    context.save();
    context.strokeStyle = this.#theme.outline;
    context.lineWidth = lineWidth;
    for (const instance of frame.document.widgets) {
      const placement = frame.previews.get(instance.id) ?? instance;
      const center = placementCenter(placement);
      context.save();
      context.translate(center.x, center.y);
      context.rotate(degreesToRadians(placement.rotation));
      const left = -placement.width / 2;
      const top = -placement.height / 2;
      // A translucent halo keeps the border readable on a bright photo, where a single light line
      // would wash out.
      context.strokeStyle = OUTLINE_HALO;
      context.lineWidth = lineWidth * 2;
      context.strokeRect(left, top, placement.width, placement.height);
      context.strokeStyle = this.#theme.outline;
      context.lineWidth = lineWidth;
      context.strokeRect(left, top, placement.width, placement.height);
      context.restore();
    }
    context.restore();
  }

  #drawSelection(context: CanvasRenderingContext2D, frame: CanvasFrame): void {
    const { scale } = frame.viewport;
    const lineWidth = 1 / scale;
    const selected: WidgetPlacement[] = [];
    for (const id of frame.selection) {
      const instance = findInstance(frame.document, id);
      if (instance !== undefined) {
        selected.push(frame.previews.get(id) ?? instance);
      }
    }

    context.save();
    context.strokeStyle = this.#theme.selection;
    context.lineWidth = lineWidth;
    context.setLineDash([4 / scale, 3 / scale]);
    for (const placement of selected) {
      const center = placementCenter(placement);
      context.save();
      context.translate(center.x, center.y);
      context.rotate(degreesToRadians(placement.rotation));
      context.strokeRect(
        -placement.width / 2,
        -placement.height / 2,
        placement.width,
        placement.height,
      );
      context.restore();
    }
    context.setLineDash([]);
    context.restore();

    // Handles belong to a single selection: a multi-selection only shows its outlines.
    const single = selected.length === 1 ? selected[0] : undefined;
    if (single === undefined) {
      return;
    }
    const points = handlePoints(single, ROTATE_HANDLE_OFFSET / scale);
    const top = handlePoints(single).n;
    const size = HANDLE_SIZE / scale;

    context.save();
    context.strokeStyle = this.#theme.handleStroke;
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(top.x, top.y);
    context.lineTo(points.rotate.x, points.rotate.y);
    context.stroke();

    context.fillStyle = this.#theme.handleFill;
    for (const handle of RESIZE_HANDLES) {
      const point = points[handle];
      context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
      context.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
    }

    context.fillStyle = this.#theme.rotateHandle;
    context.strokeStyle = this.#theme.handleStroke;
    context.beginPath();
    context.arc(points.rotate.x, points.rotate.y, ROTATE_HANDLE_RADIUS / scale, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }

  #report(diagnostic: CanvasEditorDiagnostic): void {
    this.#onDiagnostic?.(diagnostic);
  }
}

function findInstance(
  document: CanvasDocument,
  instanceId: string,
): CanvasWidgetInstance | undefined {
  return document.widgets.find((widget) => widget.id === instanceId);
}
