import {
  LABEL_DEVICE,
  parseDeviceReference,
  referencePosition,
  type DeviceSymbolProvider,
  type Point,
  type Rect,
  type SchematicHit,
} from '@mica/core/schematic';
import type { SchematicEditorController } from '../controller/controller';
import { sameSelectionItem } from '../controller/selection';
import type { EditorSelection } from '../controller/types';
import { screenToPage, type ViewportState } from '../render/viewport';
import { marqueeSelection, rectOf } from './selection-box';
import {
  MIN_HIT_PIXELS,
  connectionNodeAt,
  isPlacementTool,
  nextLabelName,
  orthogonalWaypoints,
  placementProperties,
  snapForWire,
  snapToGrid,
  toolDevice,
} from './snapping';
import type { EditorViewport } from './viewport-state';

export interface EditorInputDeps {
  readonly controller: SchematicEditorController;
  readonly devices: DeviceSymbolProvider | undefined;
  readonly viewport: EditorViewport;
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly readOnly: boolean;
  /** Called after any interaction state or document change. */
  readonly onChange: () => void;
  /** Fits the view to the document (F key, initial layout). */
  readonly onFit: () => void;
  /** Runs an edit, swallowing `SchematicError` (surfaced through `state.lastError`). */
  readonly run: (edit: () => void) => void;
}

type Drag =
  | { readonly mode: 'pan'; readonly lastX: number; readonly lastY: number }
  | { readonly mode: 'marquee'; readonly origin: Point; current: Point }
  | { readonly mode: 'move'; readonly origin: Point; offset: Point }
  | {
      readonly mode: 'reference';
      readonly symbolId: string;
      /** Reference anchor when the drag started. */
      readonly start: Point;
      readonly origin: Point;
      position: Point;
    }
  | undefined;

/**
 * Pointer and keyboard state machine: panning, rubber-band selection, wire drawing,
 * placement previews and shortcuts. It owns the transient interaction state.
 */
export class EditorInput {
  readonly #deps: EditorInputDeps;
  #hover: SchematicHit | undefined;
  #drag: Drag;
  #pendingWire: Point[] = [];
  #cursorPoint: Point | undefined;
  #detached = false;

  constructor(deps: EditorInputDeps) {
    this.#deps = deps;
  }

  get hover(): SchematicHit | undefined {
    return this.#hover;
  }

  get pendingWire(): readonly Point[] {
    return this.#pendingWire;
  }

  get cursorPoint(): Point | undefined {
    return this.#cursorPoint;
  }

  get marquee(): Rect | undefined {
    return this.#drag?.mode === 'marquee'
      ? rectOf(this.#drag.origin, this.#drag.current)
      : undefined;
  }

  /** Live offset of the symbols being dragged. */
  get dragOffset(): Point | undefined {
    if (this.#drag?.mode !== 'move') {
      return undefined;
    }
    const { offset } = this.#drag;
    return offset.x === 0 && offset.y === 0 ? undefined : offset;
  }

  /** Reference designator being dragged, in world coordinates. */
  get referencePreview(): { readonly symbolId: string; readonly position: Point } | undefined {
    return this.#drag?.mode === 'reference'
      ? { symbolId: this.#drag.symbolId, position: this.#drag.position }
      : undefined;
  }

  /** Placement ghost for the current tool, if the pointer is inside the canvas. */
  get placementPreview(): { readonly device: string; readonly position: Point } | undefined {
    const tool = this.#deps.controller.tool;
    if (this.#cursorPoint === undefined || !isPlacementTool(tool)) {
      return undefined;
    }
    return { device: toolDevice(tool), position: this.#cursorPoint };
  }

  get pendingWireWithCursor(): readonly Point[] {
    if (this.#cursorPoint === undefined) {
      return this.#pendingWire;
    }
    const previous = this.#pendingWire[this.#pendingWire.length - 1];
    if (previous === undefined) {
      return [this.#cursorPoint];
    }
    return [...this.#pendingWire, ...orthogonalWaypoints(previous, this.#cursorPoint)];
  }

  /** Drops the in-progress wire; called when the tool changes. */
  resetTransient(): void {
    this.#pendingWire = [];
    this.#cursorPoint = undefined;
  }

  attach(): void {
    const { canvas, root } = this.#deps;
    canvas.addEventListener('pointerdown', this.#onPointerDown);
    canvas.addEventListener('pointermove', this.#onPointerMove);
    canvas.addEventListener('pointerup', this.#onPointerUp);
    canvas.addEventListener('pointercancel', this.#onPointerUp);
    canvas.addEventListener('pointerleave', this.#onPointerLeave);
    canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.#onDoubleClick);
    canvas.addEventListener('contextmenu', this.#onContextMenu);
    root.addEventListener('keydown', this.#onKeyDown);
    root.addEventListener('keyup', this.#onKeyUp);
  }

  detach(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    const { canvas, root } = this.#deps;
    canvas.removeEventListener('pointerdown', this.#onPointerDown);
    canvas.removeEventListener('pointermove', this.#onPointerMove);
    canvas.removeEventListener('pointerup', this.#onPointerUp);
    canvas.removeEventListener('pointercancel', this.#onPointerUp);
    canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    canvas.removeEventListener('wheel', this.#onWheel);
    canvas.removeEventListener('dblclick', this.#onDoubleClick);
    canvas.removeEventListener('contextmenu', this.#onContextMenu);
    root.removeEventListener('keydown', this.#onKeyDown);
    root.removeEventListener('keyup', this.#onKeyUp);
  }

  #viewport(): ViewportState {
    return this.#deps.viewport.state;
  }

  #screen(event: PointerEvent | MouseEvent | WheelEvent): Point {
    const rect = this.#deps.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #page(event: PointerEvent | MouseEvent | WheelEvent): Point {
    return screenToPage(this.#viewport(), this.#screen(event));
  }

  #tolerance(): number {
    return MIN_HIT_PIXELS / this.#viewport().scale;
  }

  #snapContext(): {
    readonly controller: SchematicEditorController;
    readonly devices: DeviceSymbolProvider | undefined;
    readonly tolerance: number;
  } {
    return {
      controller: this.#deps.controller,
      devices: this.#deps.devices,
      tolerance: this.#tolerance(),
    };
  }

  #snap(page: Point): Point {
    return snapToGrid(page, this.#deps.controller.display);
  }

  #snapWire(page: Point): Point {
    return snapForWire(this.#snapContext(), page);
  }

  #selectionAt(page: Point): EditorSelection | undefined {
    const vertex = this.#vertexAt(page);
    if (vertex !== undefined) {
      return vertex;
    }
    const hit = this.#deps.controller.hitTest(page, { tolerance: this.#tolerance() });
    return hit === undefined ? undefined : selectionFromHit(hit);
  }

  #vertexAt(page: Point): EditorSelection | undefined {
    const tolerance = this.#tolerance();
    for (const wire of this.#deps.controller.document.sheet.wires) {
      for (let index = 0; index < wire.points.length; index += 1) {
        const point = wire.points[index];
        if (point === undefined) {
          continue;
        }
        if (Math.abs(point.x - page.x) <= tolerance && Math.abs(point.y - page.y) <= tolerance) {
          return { kind: 'vertex', wireId: wire.id, index };
        }
      }
    }
    return undefined;
  }

  #finishWire(): void {
    const points = this.#pendingWire;
    this.#pendingWire = [];
    this.#cursorPoint = undefined;
    this.#hover = undefined;
    if (points.length < 2) {
      this.#deps.onChange();
      return;
    }
    this.#deps.run(() => this.#deps.controller.addWire(points));
  }

  #place(page: Point): void {
    const tool = this.#deps.controller.tool;
    const point = this.#snap(page);
    const device = toolDevice(tool);
    const properties = placementProperties(tool);
    this.#deps.run(() =>
      this.#deps.controller.dispatch({
        type: 'add-symbol',
        ...(device === LABEL_DEVICE ? { id: nextLabelName(this.#deps.controller.document) } : {}),
        device,
        x: point.x,
        y: point.y,
        ...(properties === undefined ? {} : { properties }),
      }),
    );
    this.#deps.controller.setTool('select');
    this.#cursorPoint = undefined;
  }

  #startWireAtNode(page: Point): boolean {
    if (this.#deps.controller.tool !== 'select') {
      return false;
    }
    const node = connectionNodeAt(this.#snapContext(), page);
    if (node === undefined) {
      return false;
    }
    this.#pendingWire = [node];
    this.#cursorPoint = node;
    this.#deps.controller.setTool('wire');
    this.#deps.onChange();
    return true;
  }

  #select(selection: EditorSelection | undefined, additive: boolean): void {
    const controller = this.#deps.controller;
    if (selection === undefined) {
      controller.setSelection(additive ? controller.selection : []);
      return;
    }
    const current = controller.selection;
    const exists = current.some((item) => sameSelectionItem(item, selection));
    if (!additive) {
      controller.setSelection([selection]);
      return;
    }
    controller.setSelection(
      exists
        ? current.filter((item) => !sameSelectionItem(item, selection))
        : [...current, selection],
    );
  }

  #onPointerDown = (event: PointerEvent): void => {
    this.#deps.root.focus();
    const screen = this.#screen(event);
    const page = this.#page(event);

    if (event.button === 1) {
      event.preventDefault();
      this.#drag = { mode: 'pan', lastX: screen.x, lastY: screen.y };
      this.#deps.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) {
      return;
    }

    const tool = this.#deps.controller.tool;
    if (tool === 'wire') {
      const point = this.#snapWire(page);
      const previous = this.#pendingWire[this.#pendingWire.length - 1];
      this.#pendingWire = [
        ...this.#pendingWire,
        ...(previous === undefined ? [point] : orthogonalWaypoints(previous, point)),
      ];
      this.#cursorPoint = point;
      const host = this.#deps.controller.hitTest(point, {
        includeSymbols: false,
        tolerance: this.#tolerance(),
      });
      if (host?.kind === 'wire' && this.#pendingWire.length >= 2) {
        this.#finishWire();
      } else {
        this.#deps.onChange();
      }
      return;
    }

    if (isPlacementTool(tool)) {
      this.#place(page);
      return;
    }

    if (this.#startWireAtNode(page)) {
      return;
    }

    const selection = this.#selectionAt(page);
    if (selection === undefined) {
      this.#select(undefined, event.shiftKey);
      this.#drag = { mode: 'marquee', origin: page, current: page };
      this.#deps.canvas.setPointerCapture(event.pointerId);
      this.#deps.onChange();
      return;
    }
    this.#select(selection, event.shiftKey);
    if (!this.#deps.readOnly && selection.kind === 'symbol') {
      this.#drag = { mode: 'move', origin: page, offset: { x: 0, y: 0 } };
      this.#deps.canvas.setPointerCapture(event.pointerId);
    } else if (!this.#deps.readOnly && selection.kind === 'reference') {
      const symbol = this.#deps.controller.document.sheet.symbols.find(
        (item) => item.id === selection.symbolId,
      );
      if (symbol !== undefined) {
        this.#drag = {
          mode: 'reference',
          symbolId: symbol.id,
          start: this.#referenceWorldPosition(symbol),
          origin: page,
          position: this.#referenceWorldPosition(symbol),
        };
        this.#deps.canvas.setPointerCapture(event.pointerId);
      }
    }
    this.#deps.onChange();
  };

  #referenceWorldPosition(symbol: {
    readonly id: string;
    readonly device: string;
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly reference?: Point;
  }): Point {
    const reference = parseDeviceReference(symbol.device);
    const definition =
      reference === undefined ? undefined : this.#deps.devices?.getDeviceSymbol(reference);
    return referencePosition(symbol, definition?.bounds, symbol.reference);
  }

  #onPointerMove = (event: PointerEvent): void => {
    const screen = this.#screen(event);
    const page = this.#page(event);

    if (this.#drag?.mode === 'pan') {
      this.#deps.viewport.pan(screen.x - this.#drag.lastX, screen.y - this.#drag.lastY);
      this.#drag = { mode: 'pan', lastX: screen.x, lastY: screen.y };
      this.#deps.onChange();
      return;
    }
    if (this.#drag?.mode === 'marquee') {
      this.#drag = { mode: 'marquee', origin: this.#drag.origin, current: page };
      this.#deps.onChange();
      return;
    }
    if (this.#drag?.mode === 'move') {
      const display = this.#deps.controller.display;
      const step = display.snap && display.gridSize > 0 ? display.gridSize : 1;
      const dx = Math.round((page.x - this.#drag.origin.x) / step) * step;
      const dy = Math.round((page.y - this.#drag.origin.y) / step) * step;
      if (dx !== this.#drag.offset.x || dy !== this.#drag.offset.y) {
        this.#drag = { mode: 'move', origin: this.#drag.origin, offset: { x: dx, y: dy } };
        this.#deps.onChange();
      }
      return;
    }
    if (this.#drag?.mode === 'reference') {
      const { start, origin, symbolId } = this.#drag;
      this.#drag = {
        mode: 'reference',
        symbolId,
        start,
        origin,
        position: {
          x: start.x + (page.x - origin.x),
          y: start.y + (page.y - origin.y),
        },
      };
      this.#deps.onChange();
      return;
    }

    const tool = this.#deps.controller.tool;
    if (tool === 'wire') {
      this.#cursorPoint = this.#snapWire(page);
      this.#deps.onChange();
      return;
    }
    if (isPlacementTool(tool)) {
      this.#cursorPoint = this.#snap(page);
      this.#deps.onChange();
      return;
    }

    const next = this.#deps.controller.hitTest(page, { tolerance: this.#tolerance() });
    if (!sameHit(next, this.#hover)) {
      this.#hover = next;
      this.#deps.onChange();
    }
  };

  #onPointerUp = (event: PointerEvent): void => {
    const drag = this.#drag;
    this.#drag = undefined;
    if (this.#deps.canvas.hasPointerCapture(event.pointerId)) {
      this.#deps.canvas.releasePointerCapture(event.pointerId);
    }
    if (drag?.mode === 'marquee') {
      this.#deps.controller.setSelection(
        marqueeSelection(
          this.#deps.controller.document,
          rectOf(drag.origin, drag.current),
          this.#deps.devices,
        ),
      );
      return;
    }
    if (drag?.mode === 'move') {
      const { offset } = drag;
      if (offset.x !== 0 || offset.y !== 0) {
        this.#deps.run(() => this.#deps.controller.moveSelectionBy(offset.x, offset.y));
        return;
      }
    }
    if (drag?.mode === 'reference') {
      const { symbolId, start, position } = drag;
      const dx = position.x - start.x;
      const dy = position.y - start.y;
      if (dx !== 0 || dy !== 0) {
        this.#deps.run(() => this.#deps.controller.moveReferenceBy(symbolId, dx, dy));
        return;
      }
    }
    if (drag !== undefined) {
      this.#deps.onChange();
    }
  };

  #onPointerLeave = (): void => {
    if (this.#hover !== undefined && this.#drag === undefined) {
      this.#hover = undefined;
      this.#deps.onChange();
    }
  };

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.#deps.viewport.zoomAt(this.#screen(event), event.deltaY < 0 ? 1.1 : 1 / 1.1);
    this.#deps.onChange();
  };

  #onDoubleClick = (event: MouseEvent): void => {
    if (this.#deps.controller.tool === 'wire') {
      this.#finishWire();
      return;
    }
    const page = this.#page(event);
    const hit = this.#deps.controller.hitTest(page, { tolerance: this.#tolerance() });
    const selection = hit === undefined ? undefined : selectionFromHit(hit);
    if (selection !== undefined) {
      this.#deps.controller.setSelection([selection]);
    }
  };

  #onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    const controller = this.#deps.controller;
    const readOnly = this.#deps.readOnly;

    if (event.key === ' ') {
      event.preventDefault();
      if (!readOnly) {
        this.#deps.run(() => controller.rotateSelection(90));
      }
      return;
    }
    if (event.key === 'Escape') {
      this.resetTransient();
      controller.setSelection([]);
      controller.setTool('select');
      this.#deps.onChange();
      return;
    }
    if (event.key === 'Enter') {
      if (controller.tool === 'wire') {
        this.#finishWire();
      }
      return;
    }
    if (event.key === 'Backspace' && controller.tool === 'wire' && this.#pendingWire.length > 0) {
      event.preventDefault();
      this.#pendingWire = this.#pendingWire.slice(0, -1);
      this.#deps.onChange();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (!readOnly) {
        this.#deps.run(() => controller.deleteSelection());
      }
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      if (!readOnly) {
        this.#deps.run(() => controller.rotateSelection(90));
      }
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      this.#deps.onFit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      if (event.shiftKey) {
        controller.redo();
      } else {
        controller.undo();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      controller.redo();
      return;
    }
    if (readOnly) {
      return;
    }
    const step = controller.display.gridSize > 0 ? controller.display.gridSize : 1;
    const distance = event.shiftKey ? step * 10 : step;
    const deltas: Readonly<Record<string, Point>> = {
      ArrowLeft: { x: -distance, y: 0 },
      ArrowRight: { x: distance, y: 0 },
      ArrowUp: { x: 0, y: -distance },
      ArrowDown: { x: 0, y: distance },
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      this.#deps.run(() => controller.moveSelectionBy(delta.x, delta.y));
    }
  };

  #onKeyUp = (): void => {
    // No key-up handling: Space now rotates instead of acting as a pan modifier.
  };
}

function selectionFromHit(hit: SchematicHit): EditorSelection | undefined {
  switch (hit.kind) {
    case 'symbol':
      return { kind: 'symbol', id: hit.id };
    case 'reference':
      return { kind: 'reference', symbolId: hit.symbolId };
    case 'wire':
      return { kind: 'wire', id: hit.id };
    case 'junction':
      return { kind: 'junction', id: hit.id };
    case 'pin':
      return { kind: 'symbol', id: hit.symbolId };
    default:
      return undefined;
  }
}

function sameHit(left: SchematicHit | undefined, right: SchematicHit | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
