import type { CanvasDocument, CanvasWidgetInstance } from '@mica-js/core/canvas';
import type { WidgetDefinition } from '@mica-js/widget';
import { describe, expect, it } from 'vitest';
import { layerRows, zForDrop } from './layers';

function widget(id: string, ref = 'demo:segment'): CanvasWidgetInstance {
  return { id, widget: ref, x: 0, y: 0, width: 10, height: 10, rotation: 0 };
}

function documentOf(...widgets: readonly CanvasWidgetInstance[]): CanvasDocument {
  return { version: 1, widgets: [...widgets] };
}

const DEFINITIONS: ReadonlyMap<string, WidgetDefinition> = new Map([
  ['demo:segment', { properties: {}, ports: {}, displayName: '数码管' }],
]);

describe('layerRows', () => {
  it('lists the stack topmost first while keeping the document z', () => {
    const rows = layerRows(documentOf(widget('a'), widget('b'), widget('c')), DEFINITIONS);

    expect(rows.map((row) => row.id)).toEqual(['c', 'b', 'a']);
    expect(rows.map((row) => row.z)).toEqual([2, 1, 0]);
    expect(rows.map((row) => row.displayIndex)).toEqual([0, 1, 2]);
  });

  it('falls back to the widget reference until the definition resolves', () => {
    const rows = layerRows(documentOf(widget('a'), widget('b', 'demo:missing')), DEFINITIONS);

    expect(rows.map((row) => row.title)).toEqual(['demo:missing', '数码管']);
  });

  it('is empty without a document', () => {
    expect(layerRows(null, DEFINITIONS)).toEqual([]);
  });
});

describe('zForDrop', () => {
  it('mirrors the display index into the document array', () => {
    expect(zForDrop(3, 0)).toBe(2);
    expect(zForDrop(3, 1)).toBe(1);
    expect(zForDrop(3, 2)).toBe(0);
  });

  it('rejects rows outside the list', () => {
    expect(zForDrop(3, -1)).toBeUndefined();
    expect(zForDrop(3, 3)).toBeUndefined();
    expect(zForDrop(3, 1.5)).toBeUndefined();
    expect(zForDrop(0, 0)).toBeUndefined();
  });
});
