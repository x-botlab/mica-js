import type { Point, Rect, SchematicHit } from '@mica-js/core/schematic';
import type { EditorSelection } from '../../controller/types';
import type { EditorInputDeps, InteractionContext } from './context';
import { cancelInteraction, handleKeyDown } from './keyboard';
import {
  beginMoveDrag,
  beginReferenceDrag,
  finishMoveDrag,
  finishReferenceDrag,
  updateMoveDrag,
  updateReferenceDrag,
} from './move';
import {
  place,
  placementDevice,
  placementPreview,
  rotatePlacement,
  snapPlacementPoint,
} from './placement';
import { Pointer } from './pointer';
import { finishMarquee, sameHit, selectItem, selectionAt, selectionFromHit } from './selection';
import { beginSegmentDrag, finishSegmentDrag, updateSegmentDrag, wirePreview } from './segment';
import { InteractionState } from './state';
import { addWirePoint, finishWire, pendingWireWithCursor, startWireAtNode } from './wire';

export type { EditorInputDeps } from './context';

/**
 * Pointer and keyboard state machine: panning, rubber-band selection, wire drawing, placement
 * previews and shortcuts. It owns the transient interaction state and delegates to the modules
 * under `interactions/`, which never touch the DOM directly.
 */
export class EditorInput {
  readonly #context: InteractionContext;
  #detached = false;

  constructor(deps: EditorInputDeps) {
    this.#context = {
      deps,
      state: new InteractionState(),
      pointer: new Pointer({
        controller: deps.controller,
        devices: deps.devices,
        viewport: deps.viewport,
        canvas: deps.canvas,
      }),
    };
  }

  get hover(): SchematicHit | undefined {
    return this.#context.state.hover;
  }

  get pendingWire(): readonly Point[] {
    return this.#context.state.pendingWire;
  }

  get cursorPoint(): Point | undefined {
    return this.#context.state.cursorPoint;
  }

  get marquee(): Rect | undefined {
    return this.#context.state.marquee;
  }

  /** Live offset of the symbols being dragged. */
  get dragOffset(): Point | undefined {
    return this.#context.state.dragOffset;
  }

  /** Wire being reshaped by a segment drag, so the renderer can show it before the commit. */
  get wirePreview(): { readonly wireId: string; readonly points: readonly Point[] } | undefined {
    return wirePreview(this.#context);
  }

  /** Reference designator being dragged, in world coordinates. */
  get referencePreview(): { readonly symbolId: string; readonly position: Point } | undefined {
    return this.#context.state.referencePreview;
  }

  /** Placement ghost for the current tool or armed device, if the pointer is inside the canvas. */
  get placementPreview(): ReturnType<typeof placementPreview> {
    return placementPreview(this.#context);
  }

  get pendingWireWithCursor(): readonly Point[] {
    return pendingWireWithCursor(this.#context);
  }

  /** Rotates the ghost while a placement tool is active. */
  rotatePlacement(degrees: number): boolean {
    return rotatePlacement(this.#context, degrees);
  }

  /** Drops the in-progress wire; called when the tool changes. */
  resetTransient(): void {
    this.#context.state.reset();
  }

  attach(): void {
    const { canvas, root } = this.#context.deps;
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
    root.ownerDocument.addEventListener('keydown', this.#onDocumentKeyDown);
  }

  detach(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    const { canvas, root } = this.#context.deps;
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

  #onPointerDown = (event: PointerEvent): void => {
    const { deps, state, pointer } = this.#context;
    deps.root.focus();
    const screen = pointer.screen(event);
    const page = pointer.page(event);

    if (event.button === 1) {
      event.preventDefault();
      state.drag = { mode: 'pan', lastX: screen.x, lastY: screen.y };
      deps.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) {
      return;
    }

    if (deps.controller.tool === 'wire' && !deps.readOnly) {
      addWirePoint(this.#context, page);
      return;
    }
    if (!deps.readOnly && placementDevice(this.#context) !== undefined) {
      place(this.#context, page);
      return;
    }
    if (startWireAtNode(this.#context, page)) {
      return;
    }

    const selection = selectionAt(this.#context, page);
    if (selection === undefined) {
      selectItem(this.#context, undefined, event.shiftKey);
      state.drag = { mode: 'marquee', origin: page, current: page };
      deps.canvas.setPointerCapture(event.pointerId);
      deps.onChange();
      return;
    }
    selectItem(this.#context, selection, event.shiftKey);
    if (!deps.readOnly) {
      const started = beginDragFor(this.#context, page, selection);
      if (started) {
        deps.canvas.setPointerCapture(event.pointerId);
      }
    }
    deps.onChange();
  };

  #onPointerMove = (event: PointerEvent): void => {
    const { deps, state, pointer } = this.#context;
    const screen = pointer.screen(event);
    const page = pointer.page(event);

    if (state.drag?.mode === 'pan') {
      deps.viewport.pan(screen.x - state.drag.lastX, screen.y - state.drag.lastY);
      state.drag = { mode: 'pan', lastX: screen.x, lastY: screen.y };
      deps.onChange();
      return;
    }
    if (state.drag?.mode === 'marquee') {
      state.drag = { mode: 'marquee', origin: state.drag.origin, current: page };
      deps.onChange();
      return;
    }
    if (updateMoveDrag(this.#context, page)) {
      return;
    }
    if (updateReferenceDrag(this.#context, page)) {
      return;
    }
    if (updateSegmentDrag(this.#context, page)) {
      return;
    }

    const device = placementDevice(this.#context);
    if (deps.controller.tool === 'wire') {
      state.cursorPoint = pointer.snapWire(page);
      deps.onChange();
      return;
    }
    if (device !== undefined) {
      // Same snapping as the click so the ghost already shows where the symbol will land.
      state.cursorPoint = snapPlacementPoint(this.#context, page, device);
      deps.onChange();
      return;
    }

    const next = deps.controller.hitTest(page, { tolerance: pointer.tolerance() });
    if (!sameHit(next, state.hover)) {
      state.hover = next;
      deps.onChange();
    }
  };

  #onPointerUp = (event: PointerEvent): void => {
    const { deps, state } = this.#context;
    const drag = state.drag;
    state.drag = undefined;
    if (deps.canvas.hasPointerCapture(event.pointerId)) {
      deps.canvas.releasePointerCapture(event.pointerId);
    }
    if (drag?.mode === 'marquee') {
      finishMarquee(this.#context, drag.origin, drag.current);
      return;
    }
    if (drag?.mode === 'move') {
      if (!finishMoveDrag(this.#context, drag)) {
        deps.onChange();
      }
      return;
    }
    if (drag?.mode === 'reference') {
      if (!finishReferenceDrag(this.#context, drag)) {
        deps.onChange();
      }
      return;
    }
    if (drag?.mode === 'segment') {
      if (!finishSegmentDrag(this.#context, drag)) {
        deps.onChange();
      }
      return;
    }
    if (drag !== undefined) {
      deps.onChange();
    }
  };

  #onPointerLeave = (): void => {
    const { deps, state } = this.#context;
    if (state.hover !== undefined && state.drag === undefined) {
      state.hover = undefined;
      deps.onChange();
    }
  };

  #onWheel = (event: WheelEvent): void => {
    const { deps, pointer } = this.#context;
    event.preventDefault();
    deps.viewport.zoomAt(pointer.screen(event), event.deltaY < 0 ? 1.1 : 1 / 1.1);
    deps.onChange();
  };

  #onDoubleClick = (event: MouseEvent): void => {
    const { deps, pointer } = this.#context;
    if (deps.controller.tool === 'wire') {
      finishWire(this.#context);
      return;
    }
    const page = pointer.page(event);
    const hit = deps.controller.hitTest(page, { tolerance: pointer.tolerance() });
    const selection = hit === undefined ? undefined : selectionFromHit(hit);
    if (selection !== undefined) {
      deps.controller.setSelection([selection]);
    }
  };

  #onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    handleKeyDown(this.#context, event);
  };

  #onKeyUp = (): void => {
    // No key-up handling: Space now rotates instead of acting as a pan modifier.
  };

  /**
   * Esc fallback for hosts that arm placement from their own UI: the event may never reach the
   * editor root, so listen on the document while an interaction is pending.
   */
  #onDocumentKeyDown = (event: KeyboardEvent): void => {
    const { deps } = this.#context;
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }
    if (deps.root.contains(event.target as Node | null)) {
      return;
    }
    if (cancelInteraction(this.#context)) {
      event.preventDefault();
    }
  };
}

function beginDragFor(
  context: InteractionContext,
  page: Point,
  selection: EditorSelection,
): boolean {
  switch (selection.kind) {
    case 'symbol':
      return beginMoveDrag(context, page, selection.id);
    case 'reference':
      return beginReferenceDrag(context, page, selection.symbolId);
    case 'wire':
      return beginSegmentDrag(context, page, selection.id);
    default:
      return false;
  }
}
