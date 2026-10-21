import { parseDeviceReference, referencePosition, type Point } from '@mica-js/core/schematic';
import { snapDragOffset } from '../snapping';
import type { InteractionContext } from './context';

/** Starts dragging a symbol; the grid is applied where it lands, not to the pointer delta. */
export function beginMoveDrag(context: InteractionContext, page: Point, symbolId: string): boolean {
  const symbol = context.deps.controller.document.sheet.symbols.find(
    (item) => item.id === symbolId,
  );
  context.state.drag = {
    mode: 'move',
    origin: page,
    anchor: symbol === undefined ? page : { x: symbol.x, y: symbol.y },
    offset: { x: 0, y: 0 },
  };
  return true;
}

export function beginReferenceDrag(
  context: InteractionContext,
  page: Point,
  symbolId: string,
): boolean {
  const symbol = context.deps.controller.document.sheet.symbols.find(
    (item) => item.id === symbolId,
  );
  if (symbol === undefined) {
    return false;
  }
  const start = referenceWorldPosition(context, symbol);
  context.state.drag = {
    mode: 'reference',
    symbolId: symbol.id,
    start,
    origin: page,
    position: start,
  };
  return true;
}

/** Updates an in-flight move drag; returns `true` when this drag is the active one. */
export function updateMoveDrag(context: InteractionContext, page: Point): boolean {
  const drag = context.state.drag;
  if (drag?.mode !== 'move') {
    return false;
  }
  const next = snapDragOffset(drag.anchor, drag.origin, page, context.deps.controller.display);
  if (next.x !== drag.offset.x || next.y !== drag.offset.y) {
    context.state.drag = { ...drag, offset: next };
    context.deps.onChange();
  }
  return true;
}

export function updateReferenceDrag(context: InteractionContext, page: Point): boolean {
  const drag = context.state.drag;
  if (drag?.mode !== 'reference') {
    return false;
  }
  context.state.drag = {
    ...drag,
    position: {
      x: drag.start.x + (page.x - drag.origin.x),
      y: drag.start.y + (page.y - drag.origin.y),
    },
  };
  context.deps.onChange();
  return true;
}

/** Commits a finished move drag; returns whether an edit was recorded. */
export function finishMoveDrag(
  context: InteractionContext,
  drag: { readonly offset: Point },
): boolean {
  if (drag.offset.x === 0 && drag.offset.y === 0) {
    return false;
  }
  const { offset } = drag;
  context.deps.run(() => context.deps.controller.moveSelectionBy(offset.x, offset.y));
  return true;
}

export function finishReferenceDrag(
  context: InteractionContext,
  drag: {
    readonly symbolId: string;
    readonly start: Point;
    readonly position: Point;
  },
): boolean {
  const dx = drag.position.x - drag.start.x;
  const dy = drag.position.y - drag.start.y;
  if (dx === 0 && dy === 0) {
    return false;
  }
  context.deps.run(() => context.deps.controller.moveReferenceBy(drag.symbolId, dx, dy));
  return true;
}

/** World position of the reference designator of `symbol`, used as the drag anchor. */
export function referenceWorldPosition(
  context: InteractionContext,
  symbol: {
    readonly id: string;
    readonly device: string;
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly reference?: Point;
  },
): Point {
  const reference = parseDeviceReference(symbol.device);
  const definition =
    reference === undefined ? undefined : context.deps.devices?.getDeviceSymbol(reference);
  return referencePosition(symbol, definition?.bounds, symbol.reference);
}
