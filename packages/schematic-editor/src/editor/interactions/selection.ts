import { symbolRole, type Point, type SchematicHit } from '@mica-js/core/schematic';
import { sameSelectionItem } from '../../controller/selection';
import type { EditorSelection } from '../../controller/types';
import { marqueeSelection, rectOf } from '../selection-box';
import type { InteractionContext } from './context';

/** Selection under the pointer: vertices win over wire bodies, then pins/anchors/symbols. */
export function selectionAt(context: InteractionContext, page: Point): EditorSelection | undefined {
  const vertex = vertexAt(context, page);
  if (vertex !== undefined) {
    return vertex;
  }
  const hit = context.deps.controller.hitTest(page, { tolerance: context.pointer.tolerance() });
  return hit === undefined ? undefined : selectionFromHit(hit);
}

export function vertexAt(context: InteractionContext, page: Point): EditorSelection | undefined {
  const tolerance = context.pointer.tolerance();
  for (const wire of context.deps.controller.document.sheet.wires) {
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

/** True when the pointer is over a builtin annotation (label / power / ground / text). */
export function annotationSymbolAt(context: InteractionContext, page: Point): boolean {
  const hit = context.deps.controller.hitTest(page, { tolerance: context.pointer.tolerance() });
  if (hit?.kind !== 'symbol') {
    return false;
  }
  const symbol = context.deps.controller.document.sheet.symbols.find((item) => item.id === hit.id);
  return symbol !== undefined && symbolRole(symbol.device) !== 'component';
}

/** Applies a click selection, honouring additive (shift) clicks. */
export function selectItem(
  context: InteractionContext,
  selection: EditorSelection | undefined,
  additive: boolean,
): void {
  const controller = context.deps.controller;
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

/** Commits a rubber-band selection. */
export function finishMarquee(context: InteractionContext, origin: Point, current: Point): void {
  context.deps.controller.setSelection(
    marqueeSelection(
      context.deps.controller.document,
      rectOf(origin, current),
      context.deps.devices,
    ),
  );
}

export function selectionFromHit(hit: SchematicHit): EditorSelection | undefined {
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

export function sameHit(left: SchematicHit | undefined, right: SchematicHit | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
