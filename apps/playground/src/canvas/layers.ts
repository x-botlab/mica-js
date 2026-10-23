import type { CanvasDocument } from '@mica-js/core/canvas';
import type { WidgetDefinition } from '@mica-js/widget';

/** One row of the host-side layer list. */
export interface LayerRow {
  readonly id: string;
  /** Position in the `.cnv` array: `0` is the bottom of the stack. */
  readonly z: number;
  /** Position in the list, topmost first. */
  readonly displayIndex: number;
  readonly title: string;
}

/**
 * Topmost first, because a layer list reads like the stack it draws. `title` falls back to the
 * widget reference while the definition is still resolving.
 */
export function layerRows(
  document: CanvasDocument | null,
  definitions: ReadonlyMap<string, WidgetDefinition>,
): readonly LayerRow[] {
  const widgets = document?.widgets ?? [];
  const rows: LayerRow[] = [];
  for (let z = widgets.length - 1; z >= 0; z -= 1) {
    const widget = widgets[z];
    if (widget === undefined) {
      continue;
    }
    rows.push({
      id: widget.id,
      z,
      displayIndex: widgets.length - 1 - z,
      title: definitions.get(widget.widget)?.displayName ?? widget.widget,
    });
  }
  return rows;
}

/**
 * `set-z` index for dropping the dragged instance at `displayIndex`.
 *
 * `set-z` inserts into the array after taking the instance out, and the two orders are mirror
 * images, so the target z is `count - 1 - displayIndex`. `undefined` when the row is out of range.
 */
export function zForDrop(count: number, displayIndex: number): number | undefined {
  if (!Number.isInteger(displayIndex) || displayIndex < 0 || displayIndex >= count) {
    return undefined;
  }
  return count - 1 - displayIndex;
}
