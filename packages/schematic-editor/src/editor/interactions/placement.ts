import { LABEL_DEVICE, symbolRole, type Point } from '@mica-js/core/schematic';
import {
  isPlacementTool,
  labelStubAt,
  nextNetName,
  placementProperties,
  snapToGrid,
  toolDevice,
  type LabelStub,
} from '../snapping';
import type { InteractionContext } from './context';

/** Device the next click inserts: the host's armed device wins over the toolbar tool. */
export function placementDevice(context: InteractionContext): string | undefined {
  const armed = context.deps.controller.placingDevice;
  if (armed !== undefined) {
    return armed;
  }
  const tool = context.deps.controller.tool;
  return isPlacementTool(tool) ? toolDevice(tool) : undefined;
}

/** Lead a label placement adds when the pointer is on a pin. */
export function labelStub(
  context: InteractionContext,
  device: string,
  point: Point,
): LabelStub | undefined {
  return device === LABEL_DEVICE ? labelStubAt(context.pointer.snapContext(), point) : undefined;
}

/** Ghost rotation: the pin lead picks a readable angle unless the user rotated it. */
export function placeRotation(context: InteractionContext, stub: LabelStub | undefined): number {
  return context.state.placementRotation === 0 && stub !== undefined
    ? stub.rotation
    : context.state.placementRotation;
}

/** Ghost shown while a placement tool or armed device follows the pointer. */
export function placementPreview(context: InteractionContext):
  | {
      readonly device: string;
      readonly position: Point;
      readonly rotation: number;
      readonly wire?: readonly Point[];
    }
  | undefined {
  const device = placementDevice(context);
  const cursor = context.state.cursorPoint;
  if (cursor === undefined || device === undefined) {
    return undefined;
  }
  const stub = labelStub(context, device, cursor);
  return {
    device,
    position: stub?.anchor ?? cursor,
    rotation: placeRotation(context, stub),
    ...(stub?.wire === undefined ? {} : { wire: stub.wire }),
  };
}

/** Rotates the ghost while a placement tool is active. */
export function rotatePlacement(context: InteractionContext, degrees: number): boolean {
  if (placementDevice(context) === undefined) {
    return false;
  }
  context.state.placementRotation =
    (((context.state.placementRotation + degrees) % 360) + 360) % 360;
  context.deps.onChange();
  return true;
}

/** Places the armed device at `page`. */
export function place(context: InteractionContext, page: Point): void {
  const controller = context.deps.controller;
  const device = placementDevice(context);
  if (device === undefined || context.deps.readOnly) {
    return;
  }
  const role = symbolRole(device);
  // Connection points snap to pins and wire ends; components only snap to the grid.
  const snapped =
    role === 'component' ? snapToGrid(page, controller.display) : context.pointer.snapWire(page);
  // A label dropped on a pin hangs off a short lead instead of sitting on the pin.
  const stub = labelStub(context, device, snapped);
  const point = stub?.anchor ?? snapped;
  const properties = placementProperties(device);
  const designator = role === 'component' ? controller.nextDesignator(device) : undefined;
  context.deps.run(() =>
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
        rotation: placeRotation(context, stub),
        ...(properties === undefined ? {} : { properties }),
      });
    }),
  );
  controller.setTool('select');
  context.state.cursorPoint = undefined;
  context.state.placementRotation = 0;
}

/** Snapping applied to the placement ghost so it matches where the click will land. */
export function snapPlacementPoint(
  context: InteractionContext,
  page: Point,
  device: string,
): Point {
  return symbolRole(device) === 'component'
    ? snapToGrid(page, context.deps.controller.display)
    : context.pointer.snapWire(page);
}
