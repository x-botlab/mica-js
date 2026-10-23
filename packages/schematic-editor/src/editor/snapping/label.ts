import {
  DEFAULT_TEXT_CONTENT,
  GROUND_DEVICE,
  LABEL_DEVICE,
  POWER_DEVICE,
  TEXT_DEVICE,
  isTextDevice,
  netNameOf,
  parseDeviceReference,
  pinSide,
  pinsBounds,
  rotatePoint,
  type Point,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import type { EditorTool } from '../../controller/types';
import { pinPosition, type SnapContext } from './nodes';

export function isPlacementTool(tool: EditorTool): boolean {
  return tool === 'power' || tool === 'ground' || tool === 'label' || tool === 'text';
}

export function toolDevice(tool: EditorTool): string {
  switch (tool) {
    case 'power':
      return POWER_DEVICE;
    case 'ground':
      return GROUND_DEVICE;
    case 'label':
      return LABEL_DEVICE;
    default:
      return TEXT_DEVICE;
  }
}

/** Smallest unused `N<n>` net name for a freshly placed net label. */
export function nextNetName(document: SchematicDocument): string {
  const used = new Set(
    document.sheet.symbols
      .map((symbol) => netNameOf(symbol))
      .filter((name): name is string => name !== undefined),
  );
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `N${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return 'N';
}

/** Length of the lead added when a label is dropped straight onto a pin. */
export const LABEL_STUB_LENGTH = 20;

export interface LabelStub {
  /** Pin connection point. */
  readonly pin: Point;
  /** Where the label anchor goes: one lead away from the pin. */
  readonly anchor: Point;
  /** Rotation that draws the net name away from the symbol. */
  readonly rotation: number;
  /** Lead to insert; absent when an existing wire already reaches the anchor. */
  readonly wire?: readonly Point[];
}

/**
 * Lead used when a label is placed directly on a pin: labels hang off a short wire in the pin's
 * outward direction instead of sitting on the pin itself.
 */
export function labelStubAt(context: SnapContext, point: Point): LabelStub | undefined {
  const hit = context.controller.hitTest(point, {
    tolerance: context.tolerance * 2,
    includeSymbols: false,
  });
  if (hit?.kind !== 'pin') {
    return undefined;
  }
  const pin = pinPosition(context, hit);
  const direction = pinOutward(context, hit);
  if (pin === undefined || direction === undefined) {
    return undefined;
  }
  // Directions are axis aligned, so rounding removes the rotation's floating point noise.
  const dx = Math.round(direction.x);
  const dy = Math.round(direction.y);
  const anchor = {
    x: pin.x + dx * LABEL_STUB_LENGTH,
    y: pin.y + dy * LABEL_STUB_LENGTH,
  };
  const rotation = dx > 0 ? 0 : dx < 0 ? 180 : dy > 0 ? 90 : 270;
  return { pin, anchor, rotation, ...stubWire(context, pin, anchor) };
}

/** The lead only has to be drawn where no wire already runs; labels bind to any wire they touch. */
function stubWire(
  context: SnapContext,
  pin: Point,
  anchor: Point,
): { readonly wire?: readonly Point[] } {
  const host = context.controller.hitTest(anchor, {
    includeSymbols: false,
    tolerance: context.tolerance,
  });
  return host?.kind === 'wire' ? {} : { wire: [pin, anchor] };
}

/** Unit vector, in world space, pointing away from the symbol body at a pin. */
function pinOutward(
  context: SnapContext,
  hit: { readonly symbolId: string; readonly pinId: string },
): Point | undefined {
  const symbol = context.controller
    .getDocument()
    .sheet.symbols.find((item) => item.id === hit.symbolId);
  const reference = symbol === undefined ? undefined : parseDeviceReference(symbol.device);
  const definition =
    reference === undefined ? undefined : context.devices?.getDeviceSymbol(reference);
  const anchor = definition?.pins[hit.pinId];
  if (symbol === undefined || definition === undefined || anchor === undefined) {
    return undefined;
  }
  const side = pinSide(anchor, definition.bounds ?? pinsBounds(definition.pins));
  const local =
    side === 'left'
      ? { x: -1, y: 0 }
      : side === 'right'
        ? { x: 1, y: 0 }
        : side === 'top'
          ? { x: 0, y: -1 }
          : side === 'bottom'
            ? { x: 0, y: 1 }
            : undefined;
  return local === undefined ? undefined : rotatePoint(local, symbol.rotation);
}

/** Extra properties written when a placement inserts a builtin symbol. */
export function placementProperties(device: string): Record<string, string> | undefined {
  return isTextDevice(device) ? { text: DEFAULT_TEXT_CONTENT } : undefined;
}
