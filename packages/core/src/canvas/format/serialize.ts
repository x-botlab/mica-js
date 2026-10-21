import type { CanvasDocument, CanvasPlacement } from './types';

/** Serializes with a fixed field order and 2-space indentation, matching the example in #67. */
export function serializeCanvas(canvas: CanvasDocument): string {
  const layout: Record<string, CanvasPlacement> = Object.create(null);
  for (const symbolId of Object.keys(canvas.layout).sort()) {
    const placement = canvas.layout[symbolId];
    if (placement === undefined) {
      continue;
    }
    layout[symbolId] = { x: placement.x, y: placement.y, rotation: placement.rotation };
  }
  const serializable = {
    version: canvas.version,
    id: canvas.id,
    schematic: canvas.schematic,
    layout,
  };
  return `${JSON.stringify(serializable, null, 2)}\n`;
}
