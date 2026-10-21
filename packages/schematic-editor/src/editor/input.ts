import {
  LABEL_DEVICE,
  parseDeviceReference,
  referencePosition,
  symbolRole,
  type DeviceSymbolProvider,
  type Point,
  type Rect,
  type SchematicHit,
} from '@mica-js/core/schematic';
import type { SchematicEditorController } from '../controller/controller';
import { sameSelectionItem } from '../controller/selection';
import type { EditorSelection } from '../controller/types';
import { screenToPage, type ViewportState } from '../render/viewport';
import { marqueeSelection, rectOf } from './selection-box';
import {
  MIN_HIT_PIXELS,
  connectionNodeAt,
  isPlacementTool,
  labelStubAt,
  nextNetName,
  placementProperties,
  snapDragOffset,
  snapForWire,
  snapToGrid,
  toolDevice,
  wireWaypoints,
  type LabelStub,
  type WireAxis,
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
  | {
      readonly mode: 'move';
      readonly origin: Point;
      /** World position of the dragged anchor symbol when the drag started. */
      readonly anchor: Point;
      offset: Point;
    }
  | {
      readonly mode: 'reference';
      readonly symbolId: string;
      /** Reference anchor when the drag started. */
      readonly start: Point;
      readonly origin: Point;
      position: Point;
    }
  | {
      readonly mode: 'segment';
      readonly wireId: string;
      readonly segment: number;
      readonly origin: Point;
      delta: Point;
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
  #placementRotation = 0;
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

  /** Wire being reshaped by a segment drag, so the renderer can show it before the commit. */
  get wirePreview(): { readonly wireId: string; readonly points: readonly Point[] } | undefined {
    const drag = this.#drag;
    if (drag?.mode !== 'segment') {
      return undefined;
    }
    const points = this.#deps.controller.previewWireSegment(drag.wireId, drag.segment, drag.delta);
    return points === undefined ? undefined : { wireId: drag.wireId, points };
  }

  /** Reference designator being dragged, in world coordinates. */
  get referencePreview(): { readonly symbolId: string; readonly position: Point } | undefined {
    return this.#drag?.mode === 'reference'
      ? { symbolId: this.#drag.symbolId, position: this.#drag.position }
      : undefined;
  }

  /** Placement ghost for the current tool or armed device, if the pointer is inside the canvas. */
  get placementPreview():
    | {
        readonly device: string;
        readonly position: Point;
        readonly rotation: number;
        readonly wire?: readonly Point[];
      }
    | undefined {
    const device = this.#placementDevice();
    if (this.#cursorPoint === undefined || device === undefined) {
      return undefined;
    }
    const stub = this.#labelStub(device, this.#cursorPoint);
    return {
      device,
      position: stub?.anchor ?? this.#cursorPoint,
      rotation: this.#placeRotation(stub),
      ...(stub?.wire === undefined ? {} : { wire: stub.wire }),
    };
  }

  /** Device the next click inserts: the host's armed device wins over the toolbar tool. */
  #placementDevice(): string | undefined {
    const armed = this.#deps.controller.placingDevice;
    if (armed !== undefined) {
      return armed;
    }
    const tool = this.#deps.controller.tool;
    return isPlacementTool(tool) ? toolDevice(tool) : undefined;
  }

  /** Ghost rotation: the pin lead picks a readable angle unless the user rotated it. */
  #placeRotation(stub: LabelStub | undefined): number {
    return this.#placementRotation === 0 && stub !== undefined
      ? stub.rotation
      : this.#placementRotation;
  }

  /** Lead a label placement adds when the pointer is on a pin; shares the commit path's rules. */
  #labelStub(device: string, point: Point): LabelStub | undefined {
    return device === LABEL_DEVICE ? labelStubAt(this.#snapContext(), point) : undefined;
  }

  /** Rotates the ghost while a placement tool is active. */
  rotatePlacement(degrees: number): boolean {
    if (this.#placementDevice() === undefined) {
      return false;
    }
    this.#placementRotation = (((this.#placementRotation + degrees) % 360) + 360) % 360;
    this.#deps.onChange();
    return true;
  }

  get pendingWireWithCursor(): readonly Point[] {
    if (this.#cursorPoint === undefined) {
      return this.#pendingWire;
    }
    const previous = this.#pendingWire[this.#pendingWire.length - 1];
    if (previous === undefined) {
      return [this.#cursorPoint];
    }
    return [
      ...this.#pendingWire,
      ...wireWaypoints(previous, this.#cursorPoint, this.#hostAxisAt(this.#cursorPoint)),
    ];
  }

  /** Drops the in-progress wire; called when the tool changes. */
  resetTransient(): void {
    this.#pendingWire = [];
    this.#cursorPoint = undefined;
    this.#placementRotation = 0;
    this.#drag = undefined;
  }

  /**
   * Esc: cancel placement, the pending wire, a drag or the active tool and clear the selection.
   * Returns whether there was anything to cancel.
   */
  #cancelInteraction(): boolean {
    const controller = this.#deps.controller;
    const active =
      controller.placingDevice !== undefined ||
      controller.tool !== 'select' ||
      controller.selection.length > 0 ||
      this.#pendingWire.length > 0 ||
      this.#drag !== undefined;
    if (!active) {
      return false;
    }
    if (controller.placingDevice !== undefined) {
      controller.cancelPlacement();
    }
    this.resetTransient();
    controller.setSelection([]);
    controller.setTool('select');
    this.#deps.onChange();
    return true;
  }

  /**
   * Esc fallback for hosts that arm placement from their own UI: the event may never reach the
   * editor root, so listen on the document while an interaction is pending.
   */
  #onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }
    if (this.#deps.root.contains(event.target as Node | null)) {
      return;
    }
    if (this.#cancelInteraction()) {
      event.preventDefault();
    }
  };

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
    this.#deps.root.ownerDocument.addEventListener('keydown', this.#onDocumentKeyDown);
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
    root.ownerDocument.removeEventListener('keydown', this.#onDocumentKeyDown);
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

  #snapWire(page: Point): Point {
    return snapForWire(this.#snapContext(), page);
  }

  /** True when the pointer is over a builtin annotation (label / power / ground / text). */
  #annotationSymbolAt(page: Point): boolean {
    const hit = this.#deps.controller.hitTest(page, { tolerance: this.#tolerance() });
    if (hit?.kind !== 'symbol') {
      return false;
    }
    const symbol = this.#deps.controller.document.sheet.symbols.find((item) => item.id === hit.id);
    return symbol !== undefined && symbolRole(symbol.device) !== 'component';
  }

  /** Orientation of the existing wire under `point`, so a branch can approach it perpendicularly. */
  #hostAxisAt(point: Point): WireAxis | undefined {
    const hit = this.#deps.controller.hitTest(point, {
      includeSymbols: false,
      tolerance: this.#tolerance(),
    });
    if (hit?.kind !== 'wire') {
      return undefined;
    }
    const wire = this.#deps.controller.document.sheet.wires.find((item) => item.id === hit.id);
    const a = wire?.points[hit.segment];
    const b = wire?.points[hit.segment + 1];
    if (a === undefined || b === undefined) {
      return undefined;
    }
    return a.y === b.y ? 'horizontal' : a.x === b.x ? 'vertical' : undefined;
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
    if (points.length < 2 || this.#deps.readOnly) {
      this.#deps.onChange();
      return;
    }
    this.#deps.run(() => this.#deps.controller.addWire(points));
  }

  #place(page: Point): void {
    const controller = this.#deps.controller;
    const device = this.#placementDevice();
    if (device === undefined || this.#deps.readOnly) {
      return;
    }
    const role = symbolRole(device);
    // Connection points snap to pins and wire ends; components only snap to the grid.
    const snapped =
      role === 'component' ? snapToGrid(page, controller.display) : this.#snapWire(page);
    // A label dropped on a pin hangs off a short lead instead of sitting on the pin.
    const stub = this.#labelStub(device, snapped);
    const point = stub?.anchor ?? snapped;
    const properties = placementProperties(device);
    const designator = role === 'component' ? controller.nextDesignator(device) : undefined;
    this.#deps.run(() =>
      controller.transaction(() => {
        if (stub?.wire !== undefined) {
          controller.addWire(stub.wire);
        }
        controller.dispatch({
          type: 'add-symbol',
          ...(device === LABEL_DEVICE ? { net: nextNetName(controller.document) } : {}),
          ...(designator === undefined ? {} : { designator }),
          device,
          x: point.x,
          y: point.y,
          rotation: this.#placeRotation(stub),
          ...(properties === undefined ? {} : { properties }),
        });
      }),
    );
    controller.setTool('select');
    this.#cursorPoint = undefined;
    this.#placementRotation = 0;
  }

  #startWireAtNode(page: Point): boolean {
    if (this.#deps.controller.tool !== 'select' || this.#deps.readOnly) {
      return false;
    }
    // Net labels, ports and text are selection/drag targets, so a tap on their body must not be
    // eaten by a new wire; the wire tool still connects to their anchors by snapping to them.
    if (this.#annotationSymbolAt(page)) {
      return false;
    }
    const node = connectionNodeAt(this.#snapContext(), page);
    if (node === undefined) {
      return false;
    }
    // Switch the tool first: the tool change resets transient state, which must not eat the anchor.
    this.#deps.controller.setTool('wire');
    this.#pendingWire = [node];
    this.#cursorPoint = node;
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
    if (tool === 'wire' && !this.#deps.readOnly) {
      const point = this.#snapWire(page);
      const previous = this.#pendingWire[this.#pendingWire.length - 1];
      this.#pendingWire = [
        ...this.#pendingWire,
        ...(previous === undefined
          ? [point]
          : wireWaypoints(previous, point, this.#hostAxisAt(point))),
      ];
      this.#cursorPoint = point;
      // Landing on another endpoint (pin, anchor, wire end) or an existing wire closes the run.
      const node = connectionNodeAt(this.#snapContext(), point);
      const host = this.#deps.controller.hitTest(point, {
        includeSymbols: false,
        tolerance: this.#tolerance(),
      });
      const closes = node !== undefined || host?.kind === 'wire';
      if (closes && this.#pendingWire.length >= 2) {
        this.#finishWire();
        this.#deps.controller.setTool('select');
      } else {
        this.#deps.onChange();
      }
      return;
    }

    if (!this.#deps.readOnly && this.#placementDevice() !== undefined) {
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
      const anchor = this.#deps.controller.document.sheet.symbols.find(
        (item) => item.id === selection.id,
      );
      this.#drag = {
        mode: 'move',
        origin: page,
        anchor: anchor === undefined ? page : { x: anchor.x, y: anchor.y },
        offset: { x: 0, y: 0 },
      };
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
    } else if (!this.#deps.readOnly && selection.kind === 'wire') {
      // Dragging the body of a segment reshapes the wire; vertices are handled by `#vertexAt`.
      const hit = this.#deps.controller.hitTest(page, {
        includeSymbols: false,
        tolerance: this.#tolerance(),
      });
      if (hit?.kind === 'wire' && hit.id === selection.id) {
        this.#drag = {
          mode: 'segment',
          wireId: hit.id,
          segment: hit.segment,
          origin: page,
          delta: { x: 0, y: 0 },
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
      const { origin, anchor, offset } = this.#drag;
      // Snap where the symbol lands, not the raw pointer delta, so it always sits on the grid.
      const next = snapDragOffset(anchor, origin, page, this.#deps.controller.display);
      if (next.x !== offset.x || next.y !== offset.y) {
        this.#drag = { mode: 'move', origin, anchor, offset: next };
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
    if (this.#drag?.mode === 'segment') {
      const { wireId, segment, origin, delta } = this.#drag;
      const wire = this.#deps.controller.document.sheet.wires.find((item) => item.id === wireId);
      const start = wire?.points[segment];
      const end = wire?.points[segment + 1];
      if (wire !== undefined && start !== undefined && end !== undefined) {
        // Segments only slide along their normal, so the wire stays orthogonal. The moved vertex
        // is snapped (not the delta) so dragged segments land on grid lines.
        const horizontal = start.y === end.y;
        const target = snapToGrid(
          horizontal
            ? { x: start.x, y: start.y + (page.y - origin.y) }
            : { x: start.x + (page.x - origin.x), y: start.y },
          this.#deps.controller.display,
        );
        const candidate = horizontal
          ? { x: 0, y: target.y - start.y }
          : { x: target.x - start.x, y: 0 };
        if (candidate.x !== delta.x || candidate.y !== delta.y) {
          this.#drag = { mode: 'segment', wireId, segment, origin, delta: candidate };
          this.#deps.onChange();
        }
      }
      return;
    }

    const tool = this.#deps.controller.tool;
    if (tool === 'wire') {
      this.#cursorPoint = this.#snapWire(page);
      this.#deps.onChange();
      return;
    }
    const device = this.#placementDevice();
    if (device !== undefined) {
      // Same snapping as `#place` so the ghost already shows where the symbol will land.
      this.#cursorPoint =
        symbolRole(device) === 'component'
          ? snapToGrid(page, this.#deps.controller.display)
          : this.#snapWire(page);
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
    if (drag?.mode === 'segment') {
      const { wireId, segment, delta } = drag;
      if (delta.x !== 0 || delta.y !== 0) {
        this.#deps.run(() => this.#deps.controller.moveWireSegment(wireId, segment, delta));
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
      if (this.rotatePlacement(90)) {
        return;
      }
      if (!readOnly) {
        this.#deps.run(() => controller.rotateSelection(90));
      }
      return;
    }
    if (event.key === 'Escape') {
      this.#cancelInteraction();
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
      if (readOnly) {
        return;
      }
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
