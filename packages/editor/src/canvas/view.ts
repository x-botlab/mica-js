import { DisposableStore } from '@mica-js/core/lifecycle';
import type {
  CanvasDocument,
  CanvasWidgetInstance,
  WidgetPlacement,
} from '@mica-js/document/canvas';
import type { WidgetInputEvent } from '@mica-js/widget';
import type { CanvasModel } from './model';

/** A point in document units; one unit is one CSS pixel on the unzoomed surface. */
export interface ICanvasPoint {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle in document units. */
export interface ICanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Corner handle of the selected widget instance. */
export type ICanvasHandle = 'nw' | 'ne' | 'se' | 'sw';

/** Pan and zoom of the surface; `x`/`y` are the screen offset of the document origin. */
export interface ICanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** Corners in draw order: top-left, top-right, bottom-right, bottom-left. */
export const CANVAS_CORNER_HANDLES: readonly ICanvasHandle[] = ['nw', 'ne', 'se', 'sw'];
/** Smallest width and height a resize produces, in document units. */
export const CANVAS_MIN_INSTANCE_SIZE = 1;
/** Edge length of a square corner handle, in CSS pixels. */
export const CANVAS_HANDLE_SIZE = 8;
/** Radius around a corner handle that starts a resize, in CSS pixels. */
export const CANVAS_HANDLE_HIT_RADIUS = 8;
/** A press must travel this far before it becomes a drag, so a click never nudges. */
export const CANVAS_DRAG_THRESHOLD = 3;
/** Smallest and largest zoom a wheel, the zoom methods or {@link fitViewport} produce. */
export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 8;
/** Factor of one {@link ICanvasView.zoomIn} / {@link ICanvasView.zoomOut} step. */
export const CANVAS_ZOOM_FACTOR = 1.2;
/** Screen-space margin {@link fitViewport} keeps around the document bounds. */
export const CANVAS_FIT_PADDING = 24;
/** Exponent per wheel pixel: `scale * exp(-deltaY * CANVAS_WHEEL_ZOOM_RATE)`. */
export const CANVAS_WHEEL_ZOOM_RATE = 0.0015;
/** Document units between two grid lines at 100 %; the step adapts to the zoom. */
export const CANVAS_GRID_STEP = 10;
/** Smallest on-screen distance between two grid lines, in CSS pixels. */
export const CANVAS_GRID_MIN_SCREEN = 8;

/** Viewport with no pan and no zoom. */
export const CANVAS_IDENTITY_VIEWPORT: ICanvasViewport = { x: 0, y: 0, scale: 1 };

const BACKGROUND = '#f4f4f5';
const GRID_STROKE = '#e4e4e7';
const PLACEHOLDER_FILL = '#ffffff';
const PLACEHOLDER_STROKE = '#a1a1aa';
const SELECTION_STROKE = '#2563eb';
const HANDLE_FILL = '#ffffff';
const HANDLE_STROKE = '#2563eb';

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Clamps a zoom to the supported range; NaN or non-positive values fall back to the minimum. */
export function clampCanvasZoom(scale: number): number {
  if (Number.isNaN(scale) || scale <= 0) return CANVAS_MIN_ZOOM;
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, scale));
}

/** Screen (CSS pixel) point → document units. */
export function viewportToDocument(
  viewport: ICanvasViewport,
  screenPoint: ICanvasPoint,
): ICanvasPoint {
  return {
    x: (screenPoint.x - viewport.x) / viewport.scale,
    y: (screenPoint.y - viewport.y) / viewport.scale,
  };
}

/** Document units → screen (CSS pixel) point. */
export function documentToViewport(viewport: ICanvasViewport, point: ICanvasPoint): ICanvasPoint {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y,
  };
}

/**
 * Zooms around a screen point, keeping the document point under it in place.
 * The result is clamped to {@link CANVAS_MIN_ZOOM}..{@link CANVAS_MAX_ZOOM}.
 */
export function zoomViewportAt(
  viewport: ICanvasViewport,
  screenPoint: ICanvasPoint,
  scale: number,
): ICanvasViewport {
  const next = clampCanvasZoom(scale);
  if (next === viewport.scale) {
    return viewport;
  }
  const anchor = viewportToDocument(viewport, screenPoint);
  return {
    scale: next,
    x: screenPoint.x - anchor.x * next,
    y: screenPoint.y - anchor.y * next,
  };
}

/**
 * Fits document bounds into a `width` × `height` surface with `padding` screen pixels on each
 * side, centering them. Empty bounds reset the viewport.
 */
export function fitViewport(
  bounds: ICanvasRect | undefined,
  width: number,
  height: number,
  padding = CANVAS_FIT_PADDING,
): ICanvasViewport {
  if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) {
    return CANVAS_IDENTITY_VIEWPORT;
  }
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale = clampCanvasZoom(
    Math.min(availableWidth / bounds.width, availableHeight / bounds.height),
  );
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return {
    scale,
    x: width / 2 - center.x * scale,
    y: height / 2 - center.y * scale,
  };
}

/** Document-unit distance between two grid lines at `scale`, never below the screen minimum. */
export function canvasGridStep(scale: number): number {
  const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
  let step = CANVAS_GRID_STEP;
  while (step * zoom < CANVAS_GRID_MIN_SCREEN) {
    step *= 10;
  }
  while (step * zoom > CANVAS_GRID_MIN_SCREEN * 10) {
    step /= 10;
  }
  return step;
}

/** Union of the rotation-aware bounds of every instance; `undefined` for an empty canvas. */
function canvasDocumentBounds(widgets: readonly CanvasWidgetInstance[]): ICanvasRect | undefined {
  if (widgets.length === 0) {
    return undefined;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const widget of widgets) {
    for (const corner of canvasPlacementCorners(widget)) {
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Rotates a vector clockwise, matching `CanvasRenderingContext2D.rotate`. */
export function rotateCanvasVector(vector: ICanvasPoint, degrees: number): ICanvasPoint {
  const radians = degreesToRadians(degrees);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

export function canvasPlacementCenter(placement: WidgetPlacement): ICanvasPoint {
  return { x: placement.x + placement.width / 2, y: placement.y + placement.height / 2 };
}

/** Document point → offset from the instance center with the instance rotation removed. */
export function canvasPointToLocal(placement: WidgetPlacement, point: ICanvasPoint): ICanvasPoint {
  const center = canvasPlacementCenter(placement);
  return rotateCanvasVector({ x: point.x - center.x, y: point.y - center.y }, -placement.rotation);
}

/** Offset from the instance center in its unrotated frame → document point. */
export function canvasLocalToPoint(placement: WidgetPlacement, local: ICanvasPoint): ICanvasPoint {
  const center = canvasPlacementCenter(placement);
  const offset = rotateCanvasVector(local, placement.rotation);
  return { x: center.x + offset.x, y: center.y + offset.y };
}

/** True when `point` is inside the rotation-aware rectangle of `placement`. */
export function containsCanvasPoint(placement: WidgetPlacement, point: ICanvasPoint): boolean {
  const local = canvasPointToLocal(placement, point);
  return Math.abs(local.x) <= placement.width / 2 && Math.abs(local.y) <= placement.height / 2;
}

/** Topmost instance under `point`; the last entry paints above the earlier ones. */
export function hitTestCanvasInstance<T extends WidgetPlacement & { readonly id: string }>(
  instances: readonly T[],
  point: ICanvasPoint,
): T | undefined {
  for (let index = instances.length - 1; index >= 0; index -= 1) {
    const instance = instances[index];
    if (instance !== undefined && containsCanvasPoint(instance, point)) {
      return instance;
    }
  }
  return undefined;
}

export function canvasPlacementCorners(placement: WidgetPlacement): readonly ICanvasPoint[] {
  const halfWidth = placement.width / 2;
  const halfHeight = placement.height / 2;
  return [
    canvasLocalToPoint(placement, { x: -halfWidth, y: -halfHeight }),
    canvasLocalToPoint(placement, { x: halfWidth, y: -halfHeight }),
    canvasLocalToPoint(placement, { x: halfWidth, y: halfHeight }),
    canvasLocalToPoint(placement, { x: -halfWidth, y: halfHeight }),
  ];
}

/** Axis-aligned bounding box of the rotated instance. */
export function canvasPlacementBounds(placement: WidgetPlacement): ICanvasRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of canvasPlacementCorners(placement)) {
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, corner.y);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, corner.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Corner handle positions in document units. */
export function canvasHandlePoints(
  placement: WidgetPlacement,
): Readonly<Record<ICanvasHandle, ICanvasPoint>> {
  const halfWidth = placement.width / 2;
  const halfHeight = placement.height / 2;
  const at = (x: number, y: number): ICanvasPoint => canvasLocalToPoint(placement, { x, y });
  return {
    nw: at(-halfWidth, -halfHeight),
    ne: at(halfWidth, -halfHeight),
    se: at(halfWidth, halfHeight),
    sw: at(-halfWidth, halfHeight),
  };
}

/** Nearest corner handle within `radius`; corners do not overlap, so the first match wins. */
export function hitTestCanvasHandle(
  placement: WidgetPlacement,
  point: ICanvasPoint,
  radius = CANVAS_HANDLE_HIT_RADIUS,
): ICanvasHandle | undefined {
  const points = canvasHandlePoints(placement);
  for (const handle of CANVAS_CORNER_HANDLES) {
    const handlePoint = points[handle];
    if (Math.hypot(handlePoint.x - point.x, handlePoint.y - point.y) <= radius) {
      return handle;
    }
  }
  return undefined;
}

/**
 * Drags one corner to `pointer` and returns the new placement.
 *
 * The opposite corner stays where it is and the rotation is preserved, so a rotated instance is
 * resized along its own axes. Sizes are clamped to `minSize`.
 */
export function resizeCanvasPlacement(
  placement: WidgetPlacement,
  handle: ICanvasHandle,
  pointer: ICanvasPoint,
  minSize = CANVAS_MIN_INSTANCE_SIZE,
): WidgetPlacement {
  const center = canvasPlacementCenter(placement);
  const local = canvasPointToLocal(placement, pointer);
  const halfWidth = placement.width / 2;
  const halfHeight = placement.height / 2;

  let width: number;
  if (handle === 'ne' || handle === 'se') {
    width = Math.max(minSize, local.x + halfWidth);
  } else {
    width = Math.max(minSize, halfWidth - local.x);
  }
  let height: number;
  if (handle === 'se' || handle === 'sw') {
    height = Math.max(minSize, local.y + halfHeight);
  } else {
    height = Math.max(minSize, halfHeight - local.y);
  }

  // `left`/`top` place the new top-left corner in the old center's frame: the dragged corner
  // moves, the opposite one stays pinned.
  const left = handle === 'ne' || handle === 'se' ? -halfWidth : halfWidth - width;
  const top = handle === 'se' || handle === 'sw' ? -halfHeight : halfHeight - height;
  const offset = rotateCanvasVector(
    { x: left + width / 2, y: top + height / 2 },
    placement.rotation,
  );
  const centerX = center.x + offset.x;
  const centerY = center.y + offset.y;

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: placement.rotation,
  };
}

/**
 * Document point → widget-local logical units, with the origin at the widget's top-left corner.
 * The result matches `WidgetInputEvent.x` / `.y`.
 */
export function widgetPointFromCanvas(
  placement: WidgetPlacement,
  point: ICanvasPoint,
): ICanvasPoint {
  const local = canvasPointToLocal(placement, point);
  return { x: local.x + placement.width / 2, y: local.y + placement.height / 2 };
}

/** One rendered widget frame, owned by the host that runs the widget runtime. */
export interface ICanvasFrame {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface ICanvasViewOptions {
  /** Caller-provided container; the view only appends and removes its own canvas. */
  readonly container: HTMLElement;
  readonly model: CanvasModel;
  /** Disables every document edit; selection and simulation input keep working. */
  readonly readOnly?: boolean;
  /** Latest rendered frame of one instance, or `undefined` while the runtime has none. */
  readonly getFrame: (id: string) => ICanvasFrame | undefined;
  /** Forwards one simulation pointer event to a widget instance. */
  readonly onDispatch: (instanceId: string, event: WidgetInputEvent) => Promise<void>;
  /** Whether the widgets are running; only then is pointer input forwarded. */
  readonly isSimulation: () => boolean;
  /** Receives rendering, dispatch and document failures; the view keeps running. */
  readonly onError?: (error: unknown) => void;
}

export interface ICanvasView {
  /** Redraws the current document; also runs on model changes and container resizes. */
  render(): void;
  /** Zooms in one step around the surface center. */
  zoomIn(): void;
  /** Zooms out one step around the surface center. */
  zoomOut(): void;
  /** Restores the identity viewport: no pan, 100 % zoom. */
  resetView(): void;
  /** Fits the rotated widget bounds into the surface with padding; an empty canvas resets. */
  fitView(): void;
  dispose(): void;
}

type Gesture =
  | { readonly kind: 'pan'; readonly origin: ICanvasPoint; readonly start: ICanvasViewport }
  | { readonly kind: 'forward'; readonly instanceId: string }
  | {
      readonly kind: 'press';
      readonly instanceId: string;
      readonly start: WidgetPlacement;
      readonly origin: ICanvasPoint;
    }
  | {
      readonly kind: 'drag';
      readonly instanceId: string;
      readonly start: WidgetPlacement;
      readonly origin: ICanvasPoint;
    }
  | {
      readonly kind: 'resize';
      readonly instanceId: string;
      readonly start: WidgetPlacement;
      readonly handle: ICanvasHandle;
    };

interface IPreview {
  readonly instanceId: string;
  readonly placement: WidgetPlacement;
}

/**
 * Canvas2D surface over one {@link CanvasModel}.
 *
 * The view draws the document in drawing order, applies each instance rotation and draws the
 * selected instance with its corner handles. It renders on model changes, container resizes and
 * explicit {@link ICanvasView.render} calls; it has no clock of its own, so the host decides when
 * a new widget frame becomes visible.
 */
class CanvasView implements ICanvasView {
  readonly #options: ICanvasViewOptions;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D | null;
  readonly #subscriptions = new DisposableStore();
  readonly #cleanups: (() => void)[] = [];
  #observer: ResizeObserver | undefined;
  #width = 1;
  #height = 1;
  #dpr = 1;
  #viewport: ICanvasViewport = CANVAS_IDENTITY_VIEWPORT;
  #spaceHeld = false;
  #selectedId: string | undefined;
  #gesture: Gesture | undefined;
  #preview: IPreview | undefined;
  #pointerId: number | undefined;
  #disposed = false;

  constructor(options: ICanvasViewOptions) {
    this.#options = options;
    const canvas = options.container.ownerDocument.createElement('canvas');
    canvas.className = 'mica-canvas';
    canvas.tabIndex = 0;
    options.container.append(canvas);
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d');
    this.#listen('pointerdown', (event) => this.#handlePointerDown(event));
    this.#listen('pointermove', (event) => this.#handlePointerMove(event));
    this.#listen('pointerup', (event) => this.#handlePointerUp(event));
    this.#listen('pointercancel', (event) => this.#handlePointerCancel(event));
    this.#listen('lostpointercapture', () => this.#handleLostPointerCapture());
    this.#listen('keydown', (event) => this.#handleKeyDown(event));
    this.#listen('keyup', (event) => this.#handleKeyUp(event));
    this.#listen('blur', () => this.#handleBlur());
    this.#listen('wheel', (event) => this.#handleWheel(event), { passive: false });
    // Middle-button drag pans; the browser would otherwise start its own autoscroll.
    this.#listen('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    this.#listen('auxclick', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    this.#subscriptions.add(options.model.onDidChangeContent(() => this.#handleModelChange()));
    this.#observeSize();
    this.#syncSize();
    this.render();
  }

  render(): void {
    if (this.#disposed) return;
    if (this.#observer === undefined) {
      // Without a ResizeObserver the layout is the only source of the surface size.
      this.#syncSize();
    } else if (this.#devicePixelRatio() !== this.#dpr) {
      this.#applySize(this.#width, this.#height);
    }
    const context = this.#context;
    if (context === null) return;
    const document = this.#options.model.document;
    const { scale, x, y } = this.#viewport;

    context.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, this.#width, this.#height);
    context.setTransform(this.#dpr * scale, 0, 0, this.#dpr * scale, this.#dpr * x, this.#dpr * y);
    this.#drawGrid(context, scale);
    for (const instance of document.widgets) {
      this.#drawInstance(context, instance);
    }
    if (!this.#isSimulation()) {
      this.#drawSelection(context, document, scale);
    }
  }

  zoomIn(): void {
    this.#zoomBy(CANVAS_ZOOM_FACTOR);
  }

  zoomOut(): void {
    this.#zoomBy(1 / CANVAS_ZOOM_FACTOR);
  }

  resetView(): void {
    this.#setViewport(CANVAS_IDENTITY_VIEWPORT);
  }

  fitView(): void {
    this.#setViewport(
      fitViewport(
        canvasDocumentBounds(this.#options.model.document.widgets),
        this.#width,
        this.#height,
      ),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#spaceHeld = false;
    this.#endGesture();
    this.#subscriptions.dispose();
    this.#observer?.disconnect();
    this.#observer = undefined;
    for (const cleanup of this.#cleanups.splice(0)) {
      cleanup();
    }
    this.#canvas.remove();
  }

  #setViewport(viewport: ICanvasViewport): void {
    if (
      viewport.x === this.#viewport.x &&
      viewport.y === this.#viewport.y &&
      viewport.scale === this.#viewport.scale
    ) {
      return;
    }
    this.#viewport = viewport;
    this.render();
  }

  #zoomBy(factor: number): void {
    this.#setViewport(
      zoomViewportAt(
        this.#viewport,
        { x: this.#width / 2, y: this.#height / 2 },
        this.#viewport.scale * factor,
      ),
    );
  }

  #drawGrid(context: CanvasRenderingContext2D, scale: number): void {
    const step = canvasGridStep(scale);
    const topLeft = viewportToDocument(this.#viewport, { x: 0, y: 0 });
    const right = this.#width;
    const bottom = this.#height;
    const bottomRight = viewportToDocument(this.#viewport, { x: right, y: bottom });
    context.strokeStyle = GRID_STROKE;
    context.lineWidth = 1 / scale;
    context.beginPath();
    for (let x = Math.floor(topLeft.x / step) * step; x <= bottomRight.x; x += step) {
      context.moveTo(x, topLeft.y);
      context.lineTo(x, bottomRight.y);
    }
    for (let y = Math.floor(topLeft.y / step) * step; y <= bottomRight.y; y += step) {
      context.moveTo(topLeft.x, y);
      context.lineTo(bottomRight.x, y);
    }
    context.stroke();
  }

  #drawInstance(context: CanvasRenderingContext2D, instance: CanvasWidgetInstance): void {
    const preview = this.#preview;
    const placement =
      preview !== undefined && preview.instanceId === instance.id ? preview.placement : instance;
    const center = canvasPlacementCenter(placement);

    let frame: ICanvasFrame | undefined;
    try {
      frame = this.#options.getFrame(instance.id);
    } catch (error) {
      this.#report(error);
    }

    context.save();
    context.translate(center.x, center.y);
    context.rotate(degreesToRadians(placement.rotation));
    if (frame === undefined) {
      this.#drawPlaceholder(context, placement.width, placement.height);
    } else {
      try {
        context.drawImage(
          frame.bitmap,
          -placement.width / 2,
          -placement.height / 2,
          placement.width,
          placement.height,
        );
      } catch (error) {
        this.#report(error);
        this.#drawPlaceholder(context, placement.width, placement.height);
      }
    }
    context.restore();
  }

  #drawPlaceholder(context: CanvasRenderingContext2D, width: number, height: number): void {
    const { scale } = this.#viewport;
    context.fillStyle = PLACEHOLDER_FILL;
    context.fillRect(-width / 2, -height / 2, width, height);
    context.strokeStyle = PLACEHOLDER_STROKE;
    context.lineWidth = 1 / scale;
    context.setLineDash([4 / scale, 3 / scale]);
    context.strokeRect(-width / 2, -height / 2, width, height);
    context.setLineDash([]);
  }

  #drawSelection(context: CanvasRenderingContext2D, document: CanvasDocument, scale: number): void {
    const id = this.#selectedId;
    if (id === undefined) return;
    const instance = document.widgets.find((widget) => widget.id === id);
    if (instance === undefined) return;
    const preview = this.#preview;
    const placement =
      preview !== undefined && preview.instanceId === id ? preview.placement : instance;
    const center = canvasPlacementCenter(placement);

    context.save();
    context.translate(center.x, center.y);
    context.rotate(degreesToRadians(placement.rotation));
    context.strokeStyle = SELECTION_STROKE;
    context.lineWidth = 1.5 / scale;
    context.setLineDash([4 / scale, 3 / scale]);
    context.strokeRect(
      -placement.width / 2,
      -placement.height / 2,
      placement.width,
      placement.height,
    );
    context.setLineDash([]);
    context.restore();

    if (this.#readOnly) return;
    const points = canvasHandlePoints(placement);
    const size = CANVAS_HANDLE_SIZE / scale;
    const half = size / 2;
    context.fillStyle = HANDLE_FILL;
    context.strokeStyle = HANDLE_STROKE;
    context.lineWidth = 1 / scale;
    for (const handle of CANVAS_CORNER_HANDLES) {
      const point = points[handle];
      context.fillRect(point.x - half, point.y - half, size, size);
      context.strokeRect(point.x - half, point.y - half, size, size);
    }
  }

  #handleModelChange(): void {
    if (this.#disposed) return;
    this.#pruneSelection();
    const gesture = this.#gesture;
    if (gesture !== undefined && gesture.kind !== 'forward' && gesture.kind !== 'pan') {
      // A document change during a gesture (undo, host command) invalidates its preview.
      this.#endGesture();
    }
    this.render();
  }

  #handlePointerDown(event: PointerEvent): void {
    if (this.#disposed || this.#gesture !== undefined) return;
    const screen = this.#pointerScreenPoint(event);
    this.#focus();
    if (this.#isPanPress(event)) {
      this.#beginGesture(event, { kind: 'pan', origin: screen, start: this.#viewport });
      return;
    }
    const point = viewportToDocument(this.#viewport, screen);
    if (this.#isSimulation()) {
      this.#startForward(event, point);
      return;
    }
    const document = this.#options.model.document;
    const selected = this.#selectedInstance(document);
    const scale = this.#viewport.scale;
    if (!this.#readOnly && selected !== undefined) {
      const handle = hitTestCanvasHandle(selected, point, CANVAS_HANDLE_HIT_RADIUS / scale);
      if (handle !== undefined) {
        this.#beginGesture(event, {
          kind: 'resize',
          instanceId: selected.id,
          start: selected,
          handle,
        });
        return;
      }
    }
    const hit = hitTestCanvasInstance(document.widgets, point);
    this.#setSelection(hit?.id);
    if (hit === undefined || this.#readOnly) return;
    this.#beginGesture(event, {
      kind: 'press',
      instanceId: hit.id,
      start: hit,
      origin: point,
    });
  }

  /** Middle-button drag and Space + left drag pan; neither ever edits or forwards input. */
  #isPanPress(event: PointerEvent): boolean {
    if (event.button === 1) return true;
    return this.#spaceHeld && event.button === 0;
  }

  #handlePointerMove(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (this.#disposed || gesture === undefined || !this.#ownsPointer(event)) return;
    const screen = this.#pointerScreenPoint(event);

    if (gesture.kind === 'pan') {
      this.#setViewport({
        scale: gesture.start.scale,
        x: gesture.start.x + screen.x - gesture.origin.x,
        y: gesture.start.y + screen.y - gesture.origin.y,
      });
      return;
    }

    const point = viewportToDocument(this.#viewport, screen);
    if (gesture.kind === 'forward') {
      const instance = this.#findInstance(gesture.instanceId);
      if (!this.#isSimulation() || instance === undefined) {
        this.#endGesture();
        return;
      }
      this.#dispatch(gesture.instanceId, this.#pointerInput('pointermove', instance, point, event));
      return;
    }
    if (this.#readOnly || this.#isSimulation()) {
      this.#endGesture();
      return;
    }

    let active = gesture;
    if (active.kind === 'press') {
      const distance =
        Math.hypot(point.x - active.origin.x, point.y - active.origin.y) * this.#viewport.scale;
      if (distance < CANVAS_DRAG_THRESHOLD) return;
      active = {
        kind: 'drag',
        instanceId: active.instanceId,
        start: active.start,
        origin: active.origin,
      };
      this.#gesture = active;
    }

    const placement =
      active.kind === 'drag'
        ? {
            ...active.start,
            x: active.start.x + point.x - active.origin.x,
            y: active.start.y + point.y - active.origin.y,
          }
        : resizeCanvasPlacement(active.start, active.handle, point);
    this.#preview = { instanceId: active.instanceId, placement };
    this.render();
  }

  #handlePointerUp(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (this.#disposed || gesture === undefined || !this.#ownsPointer(event)) return;
    const screen = this.#pointerScreenPoint(event);

    if (gesture.kind === 'pan') {
      // Panning changed only the local viewport; the document keeps its history.
      this.#setViewport({
        scale: gesture.start.scale,
        x: gesture.start.x + screen.x - gesture.origin.x,
        y: gesture.start.y + screen.y - gesture.origin.y,
      });
      this.#endGesture();
      return;
    }

    const point = viewportToDocument(this.#viewport, screen);
    if (gesture.kind === 'forward') {
      const instance = this.#findInstance(gesture.instanceId);
      if (this.#isSimulation() && instance !== undefined) {
        this.#dispatch(gesture.instanceId, this.#pointerInput('pointerup', instance, point, event));
      }
      this.#endGesture();
      return;
    }

    if (this.#isSimulation() || this.#readOnly) {
      // A mode switch during a gesture cancels it: simulation never edits the document.
      this.#endGesture();
      this.render();
      return;
    }

    const preview = this.#preview;
    const start = gesture.start;
    this.#endGesture();
    if (preview !== undefined && !samePlacement(preview.placement, start)) {
      this.#run(() =>
        this.#options.model.apply({
          type: 'set-placement',
          instanceId: preview.instanceId,
          placement: preview.placement,
        }),
      );
      return;
    }
    this.render();
  }

  #handlePointerCancel(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (this.#disposed || gesture === undefined) return;
    if (gesture.kind === 'forward' && this.#isSimulation()) {
      const instance = this.#findInstance(gesture.instanceId);
      if (instance !== undefined) {
        const point = viewportToDocument(this.#viewport, this.#pointerScreenPoint(event));
        this.#dispatch(
          gesture.instanceId,
          this.#pointerInput('pointercancel', instance, point, event),
        );
      }
    }
    this.#endGesture();
    this.render();
  }

  /** Losing the capture ends a gesture; `pointerup` and `pointercancel` already sent their input. */
  #handleLostPointerCapture(): void {
    if (this.#disposed || this.#gesture === undefined) return;
    this.#endGesture();
    this.render();
  }

  #handleWheel(event: WheelEvent): void {
    if (this.#disposed) return;
    // The canvas owns its wheel gesture; the page keeps scrolling everywhere else.
    this.#preventDefault(event);
    const delta = wheelDelta(event, this.#height);
    if (delta === 0) return;
    const screen = this.#pointerScreenPoint(event);
    this.#setViewport(
      zoomViewportAt(
        this.#viewport,
        screen,
        this.#viewport.scale * Math.exp(-delta * CANVAS_WHEEL_ZOOM_RATE),
      ),
    );
  }

  #handleKeyDown(event: KeyboardEvent): void {
    if (this.#disposed) return;
    if (isSpaceKey(event)) {
      // Space arms panning; keeping it from the page only matters while the canvas has focus.
      this.#spaceHeld = true;
      this.#preventDefault(event);
      return;
    }
    if (this.#spaceHeld || this.#readOnly || this.#isSimulation()) return;
    const modifier = event.ctrlKey === true || event.metaKey === true;
    const key = event.key.toLowerCase();
    if (modifier && key === 'z') {
      this.#preventDefault(event);
      this.#run(() =>
        event.shiftKey === true ? this.#options.model.redo() : this.#options.model.undo(),
      );
      return;
    }
    if (modifier && key === 'y') {
      this.#preventDefault(event);
      this.#run(() => this.#options.model.redo());
      return;
    }
    if (key === 'delete' || key === 'backspace') {
      const selected = this.#selectedInstance(this.#options.model.document);
      if (selected === undefined) return;
      this.#preventDefault(event);
      this.#run(() =>
        this.#options.model.apply({ type: 'remove-instance', instanceId: selected.id }),
      );
    }
  }

  #handleKeyUp(event: KeyboardEvent): void {
    if (isSpaceKey(event)) {
      this.#spaceHeld = false;
    }
  }

  #handleBlur(): void {
    this.#spaceHeld = false;
  }

  #startForward(event: PointerEvent, point: ICanvasPoint): void {
    const hit = hitTestCanvasInstance(this.#options.model.document.widgets, point);
    if (hit === undefined) return;
    this.#beginGesture(event, { kind: 'forward', instanceId: hit.id });
    this.#dispatch(hit.id, this.#pointerInput('pointerdown', hit, point, event));
  }

  #pointerInput(
    type: string,
    placement: WidgetPlacement,
    point: ICanvasPoint,
    event: PointerEvent,
  ): WidgetInputEvent {
    const local = widgetPointFromCanvas(placement, point);
    return {
      type,
      x: local.x,
      y: local.y,
      button: typeof event.button === 'number' ? event.button : 0,
      buttons: typeof event.buttons === 'number' ? event.buttons : 0,
      altKey: event.altKey === true,
      ctrlKey: event.ctrlKey === true,
      metaKey: event.metaKey === true,
      shiftKey: event.shiftKey === true,
    };
  }

  #dispatch(instanceId: string, event: WidgetInputEvent): void {
    try {
      void this.#options
        .onDispatch(instanceId, event)
        .catch((error: unknown) => this.#report(error));
    } catch (error) {
      this.#report(error);
    }
  }

  #run(operation: () => Promise<void>): void {
    const fail = (error: unknown): void => {
      this.#report(error);
      // A rejected edit or history step leaves the document unchanged; repaint it without the
      // gesture preview so the surface never shows geometry the document does not have.
      this.render();
    };
    try {
      void operation().catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  #beginGesture(event: PointerEvent, gesture: Gesture): void {
    this.#gesture = gesture;
    this.#preview = undefined;
    const pointerId = event.pointerId;
    if (typeof pointerId === 'number' && Number.isFinite(pointerId)) {
      this.#pointerId = pointerId;
      try {
        this.#canvas.setPointerCapture(pointerId);
      } catch {
        // Capture is an optimization; a pointer that already ended still delivers its events.
      }
    } else {
      this.#pointerId = undefined;
    }
  }

  #endGesture(): void {
    const pointerId = this.#pointerId;
    this.#pointerId = undefined;
    this.#gesture = undefined;
    this.#preview = undefined;
    if (pointerId === undefined || typeof this.#canvas.releasePointerCapture !== 'function') {
      return;
    }
    try {
      if (this.#canvas.hasPointerCapture?.(pointerId) !== false) {
        this.#canvas.releasePointerCapture(pointerId);
      }
    } catch {
      // The pointer may be gone already; losing the capture is harmless here.
    }
  }

  #ownsPointer(event: PointerEvent): boolean {
    const pointerId = this.#pointerId;
    if (pointerId === undefined) return true;
    return typeof event.pointerId !== 'number' || event.pointerId === pointerId;
  }

  #selectedInstance(document: CanvasDocument): CanvasWidgetInstance | undefined {
    const id = this.#selectedId;
    return id === undefined ? undefined : document.widgets.find((widget) => widget.id === id);
  }

  #findInstance(instanceId: string): CanvasWidgetInstance | undefined {
    return this.#options.model.document.widgets.find((widget) => widget.id === instanceId);
  }

  #setSelection(id: string | undefined): void {
    if (this.#selectedId === id) return;
    this.#selectedId = id;
    this.render();
  }

  #pruneSelection(): void {
    const id = this.#selectedId;
    if (id === undefined) return;
    if (!this.#options.model.document.widgets.some((widget) => widget.id === id)) {
      this.#selectedId = undefined;
    }
  }

  #pointerScreenPoint(event: PointerEvent | WheelEvent): ICanvasPoint {
    const rect =
      typeof this.#canvas.getBoundingClientRect === 'function'
        ? this.#canvas.getBoundingClientRect()
        : { left: 0, top: 0 };
    const clientX = typeof event.clientX === 'number' ? event.clientX : 0;
    const clientY = typeof event.clientY === 'number' ? event.clientY : 0;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  #focus(): void {
    try {
      this.#canvas.focus({ preventScroll: true });
    } catch {
      // Focus is a convenience; hosts may embed the canvas without keyboard access.
    }
  }

  #preventDefault(event: KeyboardEvent | MouseEvent): void {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  }

  #isSimulation(): boolean {
    try {
      return this.#options.isSimulation();
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  get #readOnly(): boolean {
    return this.#options.readOnly ?? false;
  }

  #report(error: unknown): void {
    const onError = this.#options.onError;
    if (onError === undefined) return;
    try {
      onError(error);
    } catch {
      // A broken error handler must not break rendering or input handling.
    }
  }

  #listen<T extends keyof HTMLElementEventMap>(
    type: T,
    handler: (event: HTMLElementEventMap[T]) => void,
    options?: AddEventListenerOptions,
  ): void {
    this.#canvas.addEventListener(type, handler, options);
    this.#cleanups.push(() => this.#canvas.removeEventListener(type, handler, options));
  }

  #observeSize(): void {
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const content = entry?.contentRect;
      const width =
        content !== undefined && content.width > 0
          ? content.width
          : this.#options.container.clientWidth;
      const height =
        content !== undefined && content.height > 0
          ? content.height
          : this.#options.container.clientHeight;
      if (width <= 0 || height <= 0) return;
      this.#applySize(width, height);
      this.render();
    });
    observer.observe(this.#options.container);
    this.#observer = observer;
  }

  #syncSize(): void {
    const { clientWidth, clientHeight } = this.#options.container;
    this.#applySize(Math.max(1, clientWidth), Math.max(1, clientHeight));
  }

  #applySize(width: number, height: number): void {
    const dpr = this.#devicePixelRatio();
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    const backingWidth = Math.max(1, Math.round(nextWidth * dpr));
    const backingHeight = Math.max(1, Math.round(nextHeight * dpr));
    if (this.#canvas.width !== backingWidth) {
      this.#canvas.width = backingWidth;
    }
    if (this.#canvas.height !== backingHeight) {
      this.#canvas.height = backingHeight;
    }
    this.#width = nextWidth;
    this.#height = nextHeight;
    this.#dpr = dpr;
  }

  #devicePixelRatio(): number {
    const view = this.#canvas.ownerDocument.defaultView;
    const ratio =
      view?.devicePixelRatio ??
      (typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }
}

function samePlacement(left: WidgetPlacement, right: WidgetPlacement): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation
  );
}

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.code === 'Space' || event.key === ' ';
}

/** Wheel delta in CSS pixels; line and page modes are normalized so zoom speed stays even. */
function wheelDelta(event: WheelEvent, pageHeight: number): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, pageHeight);
  return event.deltaY;
}

/** Mounts one Canvas2D view over `options.model` and returns its handle. */
export function createCanvasView(options: ICanvasViewOptions): ICanvasView {
  return new CanvasView(options);
}
