import type { CanvasWidgetInstance } from '@mica-js/core/canvas';
import type { WidgetModule } from '@mica-js/widget';

/** One row of the host-side widget list; the ref is what `add-instance` stores. */
export interface PaletteEntry {
  readonly ref: string;
  readonly widgetId: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Geometry is host knowledge: a widget definition describes properties and ports, never a size.
 * These are the sizes that look right on the demo board; the user resizes afterwards.
 */
const DEFAULT_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  image: { width: 320, height: 240 },
  segment: { width: 130, height: 62 },
  button: { width: 64, height: 56 },
  potentiometer: { width: 180, height: 56 },
};

const FALLBACK_SIZE = { width: 160, height: 100 };
const ORIGIN = 40;
const STEP = 24;
/** Eight steps, then the cascade starts over instead of walking off the board. */
const CASCADE = 8;

/** Builds the palette from a loaded package, so `package.json` stays the single source of truth. */
export function paletteEntries(
  packageId: string,
  modules: Readonly<Record<string, WidgetModule>>,
): readonly PaletteEntry[] {
  return Object.entries(modules).map(([widgetId, module]) => {
    const size = DEFAULT_SIZES[widgetId] ?? FALLBACK_SIZE;
    return {
      ref: `${packageId}:${widgetId}`,
      widgetId,
      title: module.definition.displayName ?? widgetId,
      width: size.width,
      height: size.height,
    };
  });
}

/** New instances cascade from the top-left, so repeated clicks never stack on each other. */
export function createPaletteInstance(
  entry: PaletteEntry,
  index: number,
  id: string,
): CanvasWidgetInstance {
  const offset = ORIGIN + STEP * (index % CASCADE);
  return {
    id,
    widget: entry.ref,
    x: offset,
    y: offset,
    width: entry.width,
    height: entry.height,
    rotation: 0,
  };
}
