import type { DeviceSymbolProvider, Point } from '@mica-js/core/schematic';
import type { SchematicEditorController } from '../../controller/controller';
import { screenToPage, type ViewportState } from '../../render/viewport';
import { MIN_HIT_PIXELS, snapForWire, type SnapContext, type WireAxis } from '../snapping';
import type { EditorViewport } from '../viewport-state';

export interface PointerDeps {
  readonly controller: SchematicEditorController;
  readonly devices: DeviceSymbolProvider | undefined;
  readonly viewport: EditorViewport;
  readonly canvas: HTMLCanvasElement;
}

/** Screen-space geometry of the canvas: event → page coordinates, hit tolerance and snapping. */
export class Pointer {
  readonly #deps: PointerDeps;

  constructor(deps: PointerDeps) {
    this.#deps = deps;
  }

  viewport(): ViewportState {
    return this.#deps.viewport.state;
  }

  screen(event: PointerEvent | MouseEvent | WheelEvent): Point {
    const rect = this.#deps.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  page(event: PointerEvent | MouseEvent | WheelEvent): Point {
    return screenToPage(this.viewport(), this.screen(event));
  }

  /** Hit tolerance in page units, so it stays constant on screen while zooming. */
  tolerance(): number {
    return MIN_HIT_PIXELS / this.viewport().scale;
  }

  snapContext(): SnapContext {
    return {
      controller: this.#deps.controller,
      devices: this.#deps.devices,
      tolerance: this.tolerance(),
    };
  }

  snapWire(point: Point): Point {
    return snapForWire(this.snapContext(), point);
  }

  /** Orientation of the existing wire under `point`, so a branch can approach it perpendicularly. */
  hostAxisAt(point: Point): WireAxis | undefined {
    const hit = this.#deps.controller.hitTest(point, {
      includeSymbols: false,
      tolerance: this.tolerance(),
    });
    if (hit?.kind !== 'wire') {
      return undefined;
    }
    const wire = this.#deps.controller.getDocument().sheet.wires.find((item) => item.id === hit.id);
    const a = wire?.points[hit.segment];
    const b = wire?.points[hit.segment + 1];
    if (a === undefined || b === undefined) {
      return undefined;
    }
    return a.y === b.y ? 'horizontal' : a.x === b.x ? 'vertical' : undefined;
  }
}
