import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { loadWidgetPackage } from '../../widget/src/package/load';
import type {
  WidgetFactory,
  WidgetInstanceApi,
  WidgetPortListener,
} from '../../widget/src/guest/widget/types';
import { paletteEntries } from '../../../apps/playground/src/canvas/palette';

const root = resolve(import.meta.dirname, '../../../apps/playground/public/widgets');
let factory: WidgetFactory;
beforeAll(async () => {
  const source = await readFile(resolve(root, 'potentiometer.js'), 'utf8');
  const module = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )) as { default: WidgetFactory };
  factory = module.default;
});

function harness(props: Record<string, unknown> = {}) {
  let listener: WidgetPortListener | undefined;
  const unsubscribe = vi.fn();
  const api: WidgetInstanceApi = {
    instanceId: 'pot',
    width: 180,
    height: 56,
    props,
    assets: { readBinary: vi.fn() },
    audio: {} as WidgetInstanceApi['audio'],
    subscribe: vi.fn((port, callback) => {
      expect(port).toBe('actualPosition');
      listener = callback;
      return unsubscribe;
    }),
    publish: vi.fn(),
    invalidate: vi.fn(),
  };
  const widget = factory(api)!;
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  return {
    api,
    widget,
    context,
    unsubscribe,
    feedback: (value: unknown, simTime = 1) => listener!(value, { simTime }),
    render: () => {
      context.fillText.mockClear();
      context.arc.mockClear();
      widget.render!(context as unknown as OffscreenCanvasRenderingContext2D);
      return context.fillText.mock.calls[0]?.[0];
    },
    input: (type: string, x?: number, y = 38) =>
      widget.input!({ type, ...(x === undefined ? {} : { x }), y, button: 0 }),
    key: (key: string, extra = {}) => widget.input!({ type: 'keydown', key, ...extra }),
  };
}

test('loads the real package, numeric ports, default schema and stable palette size', async () => {
  const loaded = await loadWidgetPackage({
    label: 'demo',
    read: (path) => readFile(resolve(root, path)),
  });
  const module = loaded.modules['potentiometer']!;
  expect(module.code).toContain('export default function potentiometer');
  expect(module.definition.ports).toEqual({
    position: { direction: 'output', type: 'number', title: 'Position' },
    actualPosition: { direction: 'input', type: 'number', title: 'Actual Position' },
  });
  expect(module.definition.properties['initialPosition']).toMatchObject({
    type: 'number',
    default: 0.5,
    min: 0,
    max: 1,
  });
  expect(paletteEntries(loaded.id, loaded.modules)).toContainEqual({
    ref: 'demo:potentiometer',
    widgetId: 'potentiometer',
    title: '电位器',
    width: 180,
    height: 56,
  });
});

describe('actual potentiometer canvas module', () => {
  test('renders an unframed track and thumb with separate fitted label and value', () => {
    const h = harness({ label: 'A very long potentiometer label' });
    expect(h.render()).toBe('50%');
    expect(h.context.arc).toHaveBeenCalledWith(90, 56 * 0.68, 7, 0, Math.PI * 2);
    expect(h.context.clearRect).toHaveBeenCalledWith(0, 0, 180, 56);
    expect(h.context.fill).toHaveBeenCalledTimes(1);
    expect(h.context.lineTo).toHaveBeenCalledWith(168, 56 * 0.68);
    const [value, label] = h.context.fillText.mock.calls;
    expect(label![0]).toBe('A very long potentiometer label');
    expect(label![1] + label![3]!).toBeLessThan(value![1] - value![3]!);
    expect(h.api.publish).not.toHaveBeenCalled();
  });

  test.each([
    [undefined, '50%'],
    [NaN, '50%'],
    ['0.2', '50%'],
    [0.2, '20%'],
    [-1, '0%'],
    [2, '100%'],
  ])('normalizes initial position %s without publishing', (initialPosition, value) => {
    const h = harness({ initialPosition });
    expect(h.render()).toBe(value);
    expect(h.api.publish).not.toHaveBeenCalled();
  });

  test('drags continuously in local units, clamps outside capture and commits the release', () => {
    const h = harness();
    h.input('pointermove', 168);
    expect(h.api.publish).not.toHaveBeenCalled();
    h.input('pointerdown', 12);
    h.input('pointermove', 51);
    h.input('pointermove', 51);
    h.input('pointermove', 1000);
    h.input('pointerup', 129);
    expect(vi.mocked(h.api.publish).mock.calls).toEqual([
      ['position', 0],
      ['position', 0.25],
      ['position', 1],
      ['position', 0.75],
    ]);
    expect(h.render()).toBe('75%');
    h.input('pointermove', 12);
    h.input('pointerup', 12);
    expect(h.api.publish).toHaveBeenCalledTimes(4);
  });

  test('cancellation keeps the published value and stops dragging without using cancel coordinates', () => {
    const h = harness();
    h.input('pointerdown', 51);
    h.input('pointercancel', 168);
    h.input('pointermove', 168);
    expect(h.render()).toBe('25%');
    expect(h.api.publish).toHaveBeenCalledExactlyOnceWith('position', 0.25);
    h.feedback(0.25);
    h.feedback(0.6, 2);
    expect(h.render()).toBe('60%');
  });

  test('rejects malformed feedback and accepts clamped feedback without publishing', () => {
    const h = harness();
    for (const value of [NaN, Infinity, -Infinity, null, undefined, true, '0.2', {}])
      h.feedback(value, 100);
    h.feedback(0.2, NaN);
    expect(h.render()).toBe('50%');
    expect(h.api.invalidate).not.toHaveBeenCalled();
    h.feedback(-2, 1);
    expect(h.render()).toBe('0%');
    h.feedback(2, 2);
    expect(h.render()).toBe('100%');
    h.feedback(0.2, 1);
    expect(h.render()).toBe('100%');
    expect(h.api.publish).not.toHaveBeenCalled();
  });

  test('delayed intermediate feedback cannot overwrite the latest drag; acknowledgment restores synchronization', () => {
    const h = harness();
    h.input('pointerdown', 51);
    h.input('pointermove', 129);
    h.feedback(0.25, 1);
    expect(h.render()).toBe('75%');
    h.input('pointerup', 129);
    h.feedback(0.25, 2);
    expect(h.render()).toBe('75%');
    h.feedback(0.75, 3);
    h.feedback(0.25, 2);
    expect(h.render()).toBe('75%');
    h.feedback(0.4, 4);
    expect(h.render()).toBe('40%');
    expect(h.api.publish).toHaveBeenCalledTimes(2);
  });

  test('feedback during capture never moves the thumb, even after acknowledgment', () => {
    const h = harness();
    h.input('pointerdown', 129);
    h.feedback(0.75, 1);
    h.feedback(0.2, 2);
    expect(h.render()).toBe('75%');
    h.input('pointerup', 129);
    h.feedback(0.2, 3);
    expect(h.render()).toBe('20%');
  });

  test('supports keyboard steps, shift steps and endpoints without modifier hijacking', () => {
    const h = harness();
    h.key('ArrowRight');
    expect(h.render()).toBe('51%');
    h.key('ArrowUp', { shiftKey: true });
    expect(h.render()).toBe('61%');
    h.key('ArrowLeft');
    h.key('ArrowDown', { shiftKey: true });
    expect(h.render()).toBe('50%');
    h.key('Home');
    h.key('ArrowLeft');
    expect(h.render()).toBe('0%');
    h.key('End');
    h.key('ArrowRight');
    expect(h.render()).toBe('100%');
    const count = vi.mocked(h.api.publish).mock.calls.length;
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }])
      h.key('Home', extra);
    h.key('Enter');
    expect(h.api.publish).toHaveBeenCalledTimes(count);
    h.input('pointerdown', 51);
    h.key('End');
    expect(h.render()).toBe('25%');
  });

  test('ignores invalid pointer input and nonprimary presses', () => {
    const h = harness();
    h.widget.input!({ type: 'pointerdown', x: 168, y: 38, button: 2 });
    for (const [x, y] of [
      [NaN, 20],
      [Infinity, 20],
      [10, NaN],
      [-1, 20],
      [10, 60],
    ])
      h.input('pointerdown', x, y);
    h.input('pointerdown');
    h.input('pointermove', 168);
    expect(h.api.publish).not.toHaveBeenCalled();
    h.input('pointerdown', 51);
    h.input('pointermove', NaN);
    h.input('pointerup');
    expect(h.render()).toBe('25%');
    expect(h.api.publish).toHaveBeenCalledTimes(1);
  });

  test('renders safely in small, resized and zero-sized bounds', () => {
    const h = harness();
    Object.assign(h.api, { width: 16, height: 8 });
    expect(h.render()).toBe('50%');
    for (const call of h.context.fillText.mock.calls) expect(call[3]).toBeGreaterThan(0);
    Object.assign(h.api, { width: 336, height: 80 });
    h.input('pointerdown', 168);
    h.input('pointermove', 324);
    expect(h.render()).toBe('100%');
    Object.assign(h.api, { width: 0 });
    expect(h.render()).toBeUndefined();
    Object.assign(h.api, { width: NaN });
    expect(h.render()).toBeUndefined();
  });

  test('unsubscribes once and makes retained callbacks and hooks inert after disposal', () => {
    const h = harness();
    h.input('pointerdown', 51);
    h.widget.dispose!();
    h.widget.dispose!();
    vi.mocked(h.api.invalidate).mockClear();
    vi.mocked(h.api.publish).mockClear();
    h.feedback(0.8);
    h.input('pointermove', 168);
    h.input('pointerdown', 168);
    h.key('End');
    expect(h.render()).toBeUndefined();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.api.invalidate).not.toHaveBeenCalled();
    expect(h.api.publish).not.toHaveBeenCalled();
  });
});
