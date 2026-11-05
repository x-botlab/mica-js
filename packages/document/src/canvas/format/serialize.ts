import type { CanvasBindingTarget, CanvasDocument, CanvasWidgetInstance } from './types';

/**
 * Serializes with a fixed field order and 2-space indentation, matching the example in #67.
 * `properties` and `bindings` are written whenever the document carries them, even when empty, so
 * a parse / serialize round trip keeps the original shape.
 */
export function serializeCanvas(document: CanvasDocument): string {
  const serializable: Record<string, unknown> = { version: document.version };
  if (document.schematic !== undefined) {
    serializable['schematic'] = document.schematic;
  }
  serializable['widgets'] = document.widgets.map(serializeWidget);
  return `${JSON.stringify(serializable, null, 2)}\n`;
}

function serializeWidget(widget: CanvasWidgetInstance): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    id: widget.id,
    widget: widget.widget,
    x: widget.x,
    y: widget.y,
    width: widget.width,
    height: widget.height,
    rotation: widget.rotation,
  };
  if (widget.properties !== undefined) {
    serialized['properties'] = { ...widget.properties };
  }
  if (widget.bindings !== undefined) {
    const bindings: Record<string, CanvasBindingTarget> = Object.create(null);
    for (const [port, target] of Object.entries(widget.bindings)) {
      bindings[port] = { symbol: target.symbol, port: target.port };
    }
    serialized['bindings'] = bindings;
  }
  return serialized;
}
