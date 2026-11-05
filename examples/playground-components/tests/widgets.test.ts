import { describe, expect, it, vi } from 'vitest';
import { validateMetadata } from '@mica-js/sdk/metadata';
import type {
  WidgetFactory,
  WidgetImplementation,
  WidgetInstanceApi,
  WidgetPortListener,
} from '@mica-js/sdk/widget';
import button from '../src/widgets/button/index.js';
import led from '../src/widgets/led-indicator/index.js';
import voltmeter from '../src/widgets/voltmeter/index.js';
import buttonMetadata from '../src/widgets/button/widget.json';
import ledMetadata from '../src/widgets/led-indicator/widget.json';
import voltmeterMetadata from '../src/widgets/voltmeter/widget.json';

function mount(factory: WidgetFactory, props: Record<string, unknown> = {}) {
  const listeners = new Map<string, WidgetPortListener>();
  const unsubscribe = vi.fn();
  const api: WidgetInstanceApi = {
    instanceId: 'test',
    width: 140,
    height: 90,
    props,
    assets: { readBinary: vi.fn() },
    audio: {} as WidgetInstanceApi['audio'],
    subscribe: (port, listener) => {
      listeners.set(port, listener);
      return unsubscribe;
    },
    publish: vi.fn(),
    invalidate: vi.fn(),
  };
  const widget = factory(api) as WidgetImplementation;
  return {
    api,
    widget,
    unsubscribe,
    deliver: (port: string, value: unknown) => listeners.get(port)?.(value, { simTime: 0 }),
  };
}

function canvas() {
  const fills: { color: unknown; alpha: number }[] = [];
  const ctx = {
    fillStyle: '',
    globalAlpha: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillText: vi.fn(),
    fill() {
      fills.push({ color: ctx.fillStyle, alpha: ctx.globalAlpha });
    },
  };
  return { ctx, fills, context: ctx as unknown as OffscreenCanvasRenderingContext2D };
}

const down = { type: 'pointerdown', button: 0, x: 50, y: 30 };
const up = { ...down, type: 'pointerup' };

describe('instrument widgets', () => {
  it.each([buttonMetadata, ledMetadata, voltmeterMetadata])(
    'validates metadata for $id',
    (metadata) => {
      expect(() => validateMetadata(metadata, 'widget', metadata.id)).not.toThrow();
    },
  );

  it('publishes momentary presses and releases outside after capture or cancellation', () => {
    const { api, widget } = mount(button);
    expect(api.publish).toHaveBeenCalledExactlyOnceWith('press', false);
    widget.input?.(down);
    widget.input?.(down);
    widget.input?.({ type: 'pointerleave' });
    expect(api.publish).toHaveBeenLastCalledWith('press', true);
    widget.input?.({ ...up, x: 400 });
    expect(api.publish).toHaveBeenLastCalledWith('press', false);
    widget.input?.(down);
    widget.input?.({ type: 'pointercancel' });
    widget.input?.(up);
    expect(api.publish).toHaveBeenCalledTimes(5);
    expect(api.publish).toHaveBeenLastCalledWith('press', false);
  });

  it('ignores nonprimary buttons and presses outside bounds', () => {
    const { api, widget } = mount(button);
    widget.input?.({ ...down, button: 2 });
    widget.input?.(up);
    widget.input?.({ ...down, x: -1 });
    widget.input?.(up);
    expect(api.publish).toHaveBeenCalledTimes(1);
  });

  it('clamps LED brightness, rejects invalid input, and unsubscribes', () => {
    const { widget, deliver, unsubscribe } = mount(led);
    const { context, fills } = canvas();
    deliver('brightness', 0.5);
    widget.render?.(context);
    expect(fills).toContainEqual({ color: '#45c692', alpha: 0.5 });
    deliver('brightness', 8);
    widget.render?.(context);
    expect(fills).toContainEqual({ color: '#45c692', alpha: 1 });
    deliver('brightness', -4);
    fills.length = 0;
    widget.render?.(context);
    expect(fills.some((fill) => fill.color === '#45c692')).toBe(false);
    deliver('brightness', NaN);
    deliver('brightness', '1');
    fills.length = 0;
    widget.render?.(context);
    expect(fills.some((fill) => fill.color === '#45c692')).toBe(false);
    widget.dispose?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, '12.35 V'],
    [99, '12.3457 V'],
    [-4, '12 V'],
    [1.9, '12.3 V'],
    [NaN, '12.35 V'],
  ])('bounds voltage display precision %s', (precision, expected) => {
    const { widget, deliver, unsubscribe } = mount(voltmeter, { precision });
    const { ctx, context } = canvas();
    deliver('voltage', 12.34567);
    deliver('voltage', Infinity);
    deliver('voltage', 'invalid');
    widget.render?.(context);
    expect(ctx.fillText).toHaveBeenCalledWith(
      expected,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
    widget.dispose?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('renders initial zero voltage and large negative readings with units', () => {
    const { widget, deliver } = mount(voltmeter);
    const { ctx, context } = canvas();
    widget.render?.(context);
    expect(ctx.fillText).toHaveBeenCalledWith(
      '0.00 V',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
    deliver('voltage', -1.5e20);
    widget.render?.(context);
    expect(ctx.fillText).toHaveBeenLastCalledWith(
      '-1.50e+20 V',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it.each([button, led, voltmeter])(
    'clips rendering and tolerates tiny, narrow, wide, and zero bounds',
    (factory) => {
      const { api, widget } = mount(factory);
      for (const [width, height] of [
        [140, 90],
        [1, 1],
        [25, 150],
        [300, 24],
        [0, 0],
      ]) {
        Object.assign(api, { width, height });
        const { ctx, context } = canvas();
        expect(() => widget.render?.(context)).not.toThrow();
        if (width && height) {
          expect(ctx.clip).toHaveBeenCalledOnce();
          expect(ctx.save).toHaveBeenCalledTimes(ctx.restore.mock.calls.length);
          for (const args of ctx.arc.mock.calls)
            expect((args as unknown as number[])[2]).toBeGreaterThanOrEqual(0);
        } else {
          expect(ctx.save).not.toHaveBeenCalled();
        }
      }
    },
  );
});
