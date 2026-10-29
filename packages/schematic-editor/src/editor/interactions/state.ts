import type { Point, Rect, SchematicHit } from '@mica-js/core/schematic';
import { rectOf } from '../selection-box';

export type DragInteraction =
  | { readonly mode: 'pan'; readonly lastX: number; readonly lastY: number }
  | { readonly mode: 'marquee'; readonly origin: Point; readonly current: Point }
  | {
      readonly mode: 'move';
      readonly origin: Point;
      /** World position of the dragged symbol when the drag started. */
      readonly anchor: Point;
      readonly offset: Point;
    }
  | {
      readonly mode: 'reference';
      readonly symbolId: string;
      /** Reference anchor when the drag started. */
      readonly start: Point;
      readonly origin: Point;
      readonly position: Point;
    }
  | {
      readonly mode: 'segment';
      readonly wireId: string;
      readonly segment: number;
      readonly origin: Point;
      readonly delta: Point;
    }
  | undefined;

/**
 * Transient interaction state owned by the canvas. Nothing here belongs in the document, so the
 * document model never sees hovers, in-progress wires or previews.
 */
export class InteractionState {
  hover: SchematicHit | undefined;
  drag: DragInteraction;
  pendingWire: Point[] = [];
  cursorPoint: Point | undefined;
  placementRotation = 0;

  get marquee(): Rect | undefined {
    return this.drag?.mode === 'marquee' ? rectOf(this.drag.origin, this.drag.current) : undefined;
  }

  /** Live offset of the symbols being dragged. */
  get dragOffset(): Point | undefined {
    if (this.drag?.mode !== 'move') {
      return undefined;
    }
    const { offset } = this.drag;
    return offset.x === 0 && offset.y === 0 ? undefined : offset;
  }

  /** Reference designator being dragged, in world coordinates. */
  get referencePreview(): { readonly symbolId: string; readonly position: Point } | undefined {
    return this.drag?.mode === 'reference'
      ? { symbolId: this.drag.symbolId, position: this.drag.position }
      : undefined;
  }

  /** Drops the interaction in progress; called when the tool changes or an edit is cancelled. */
  reset(): void {
    this.pendingWire = [];
    this.cursorPoint = undefined;
    this.placementRotation = 0;
    this.drag = undefined;
  }
}
