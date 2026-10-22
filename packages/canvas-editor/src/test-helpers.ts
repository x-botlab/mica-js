import {
  CANVAS_VERSION,
  type CanvasDocument,
  type CanvasWidgetInstance,
} from '@mica-js/core/canvas';

/** Builds a widget instance with defaults that keep the geometry assertions readable. */
export function widget(
  id: string,
  placement: Partial<Omit<CanvasWidgetInstance, 'id'>> = {},
): CanvasWidgetInstance {
  return {
    id,
    widget: 'builtin:test',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    ...placement,
  };
}

export function canvasDocument(...widgets: readonly CanvasWidgetInstance[]): CanvasDocument {
  return { version: CANVAS_VERSION, widgets };
}
