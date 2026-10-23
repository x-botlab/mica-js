import type { WidgetModule } from '@mica-js/widget';
import { describe, expect, it } from 'vitest';
import { createPaletteInstance, paletteEntries } from './palette';

function moduleOf(displayName?: string): WidgetModule {
  return {
    definition: {
      properties: {},
      ports: {},
      ...(displayName === undefined ? {} : { displayName }),
    },
    code: 'export default () => ({});',
  };
}

const MODULES: Readonly<Record<string, WidgetModule>> = {
  segment: moduleOf('数码管'),
  button: moduleOf(),
  unknown: moduleOf('未知件'),
};

describe('paletteEntries', () => {
  it('builds refs and titles from the package manifest', () => {
    const entries = paletteEntries('demo', MODULES);

    expect(entries.map((entry) => entry.ref)).toEqual([
      'demo:segment',
      'demo:button',
      'demo:unknown',
    ]);
    expect(entries.map((entry) => entry.title)).toEqual(['数码管', 'button', '未知件']);
  });

  it('uses the host default size and falls back for widgets it has no size for', () => {
    const byId = new Map(paletteEntries('demo', MODULES).map((entry) => [entry.widgetId, entry]));

    expect(byId.get('segment')).toMatchObject({ width: 130, height: 62 });
    expect(byId.get('unknown')).toMatchObject({ width: 160, height: 100 });
  });
});

describe('createPaletteInstance', () => {
  const entry = {
    ref: 'demo:button',
    widgetId: 'button',
    title: '按键',
    width: 64,
    height: 56,
  };

  it('cascades new instances so repeated clicks do not stack', () => {
    const first = createPaletteInstance(entry, 0, 'aaaaaaaa-0000-4000-8000-000000000001');
    const second = createPaletteInstance(entry, 1, 'aaaaaaaa-0000-4000-8000-000000000002');

    expect(first).toMatchObject({ x: 40, y: 40, widget: 'demo:button', width: 64, height: 56 });
    expect(second.x - first.x).toBe(24);
    expect(second.y - first.y).toBe(24);
  });

  it('wraps the cascade instead of walking off the board', () => {
    const wrapped = createPaletteInstance(entry, 8, 'aaaaaaaa-0000-4000-8000-000000000003');
    const first = createPaletteInstance(entry, 0, 'aaaaaaaa-0000-4000-8000-000000000001');

    expect(wrapped.x).toBe(first.x);
    expect(wrapped.y).toBe(first.y);
  });

  it('only sets what the document stores', () => {
    const instance = createPaletteInstance(entry, 0, 'aaaaaaaa-0000-4000-8000-000000000004');

    expect(Object.keys(instance).sort()).toEqual([
      'height',
      'id',
      'rotation',
      'widget',
      'width',
      'x',
      'y',
    ]);
    expect(instance.rotation).toBe(0);
  });
});
