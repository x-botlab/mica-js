import { describe, expect, it, vi } from 'vitest';
import { validateMetadata } from '@mica-js/sdk/metadata';
import type {
  WidgetFactory,
  WidgetImplementation,
  WidgetInstanceApi,
  WidgetPortListener,
} from '@mica-js/sdk/widget';
import button from '../src/widgets/button/index.js';
import image from '../src/widgets/image/index.js';
import indicator from '../src/widgets/led-indicator/index.js';
import segment from '../src/widgets/segment/index.js';
import buttonMetadata from '../src/widgets/button/widget.json';
import imageMetadata from '../src/widgets/image/widget.json';
import indicatorMetadata from '../src/widgets/led-indicator/widget.json';
import segmentMetadata from '../src/widgets/segment/widget.json';

/**
 * 三个板面 widget 的行为基线：元数据、按键发布、段码点亮，以及背景图的加载/占位两条路径。
 *
 * widget 运行在 guest worker 里，这里用最小 API 与假 2D 上下文替代，不涉及沙箱与 DOM。
 */

function mount(
  factory: WidgetFactory,
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly props?: Record<string, unknown>;
    readonly readBinary?: (src: string) => Promise<Uint8Array>;
  } = {},
) {
  const listeners = new Map<string, WidgetPortListener>();
  const published: { port: string; payload: unknown }[] = [];
  const unsubscribe = vi.fn();
  let invalidations = 0;
  const api: WidgetInstanceApi = {
    instanceId: 'test',
    width: options.width ?? 40,
    height: options.height ?? 40,
    props: options.props ?? {},
    assets: { readBinary: options.readBinary ?? (async () => new Uint8Array()) },
    audio: {} as WidgetInstanceApi['audio'],
    subscribe: (port, listener) => {
      listeners.set(port, listener);
      return unsubscribe;
    },
    publish: (port, payload) => {
      published.push({ port, payload });
    },
    invalidate: () => {
      invalidations += 1;
    },
  };
  const widget = (factory(api) as WidgetImplementation) ?? {};

  return {
    widget,
    published,
    invalidations: () => invalidations,
    deliver: (port: string, payload: unknown) => listeners.get(port)?.(payload, { simTime: 0 }),
  };
}

function canvas() {
  const fills: string[] = [];
  const fillRects: string[] = [];
  const images: { width: number; height: number; x: number; y: number }[] = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    clearRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    roundRect: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    fill() {
      fills.push(context.fillStyle);
    },
    fillRect() {
      fillRects.push(context.fillStyle);
    },
    drawImage(_bitmap: unknown, x: number, y: number, width: number, height: number) {
      images.push({ x, y, width, height });
    },
  };
  return {
    fills,
    fillRects,
    images,
    context: context as unknown as OffscreenCanvasRenderingContext2D,
  };
}

describe('板面 widget 定义', () => {
  it.each([
    [imageMetadata, 'image'],
    [buttonMetadata, 'button'],
    [segmentMetadata, 'segment'],
    [indicatorMetadata, 'led-indicator'],
  ])('%s 通过 SDK 校验', (metadata, id) => {
    expect(() => validateMetadata(metadata, 'widget', id)).not.toThrow();
  });

  it('数码管的四个段码端口与 seg4 的 digit1–digit4 对齐', () => {
    expect(Object.keys(segmentMetadata.ports).sort()).toEqual([
      'digit1',
      'digit2',
      'digit3',
      'digit4',
    ]);
    for (const port of Object.values(segmentMetadata.ports)) {
      expect(port).toMatchObject({ direction: 'input', type: 'number', delivery: 'level' });
    }
  });
});

describe('按键', () => {
  it('创建时发布 press=false，按下/松开各发布一次', () => {
    const { widget, published } = mount(button, { width: 40, height: 40 });
    const { context } = canvas();
    widget.render?.(context);

    expect(published).toEqual([{ port: 'press', payload: false }]);
    widget.input?.({ type: 'pointerdown', button: 0, x: 20, y: 20 });
    expect(published.at(-1)).toEqual({ port: 'press', payload: true });
    widget.input?.({ type: 'pointerup', x: 240, y: 240 });
    expect(published.at(-1)).toEqual({ port: 'press', payload: false });
  });

  it('热区外按下、非左键与非指针事件都不改变状态', () => {
    const { widget, published } = mount(button);
    widget.input?.({ type: 'pointerdown', button: 0, x: 400, y: 400 });
    widget.input?.({ type: 'pointerdown', button: 2, x: 1, y: 1 });
    widget.input?.({ type: 'keydown', key: 'Enter' });
    expect(published).toEqual([{ port: 'press', payload: false }]);
  });
});

describe('四位数码管', () => {
  const litCount = (mask: number): number => {
    let count = 0;
    for (let bit = 0; bit < 8; bit += 1) if ((mask & (1 << bit)) !== 0) count += 1;
    return count;
  };

  it('按段码点亮，逐位独立，越界值按 8 位掩码钳制', () => {
    const { widget, deliver } = mount(segment, { width: 126, height: 60 });
    const masks = [0x06, 0x5b, 0x7f, 0x80];
    masks.forEach((mask, index) => deliver(`digit${index + 1}`, mask));
    // 999 钳到 255（全亮），NaN 被忽略、保持原值。
    deliver('digit1', 999);
    deliver('digit2', Number.NaN);
    const expected = [0xff, ...masks.slice(1)];

    const { fills, context } = canvas();
    widget.render?.(context);

    // 1 次底色 + 4 位 × (7 段 + 小数点)。
    expect(fills).toHaveLength(1 + 4 * 8);
    const lit = fills.filter((color) => color === 'rgba(255, 59, 48, 1)');
    expect(lit).toHaveLength(expected.reduce((total, mask) => total + litCount(mask), 0));
  });

  it('尺寸无效时跳过绘制', () => {
    const { widget } = mount(segment, { width: 0, height: 0 });
    const { fills, context } = canvas();
    widget.render?.(context);
    expect(fills).toEqual([]);
  });
});

describe('LED 指示灯', () => {
  it('亮度驱动光晕，0 时不画任何东西', () => {
    const { widget, deliver } = mount(indicator, { width: 18, height: 26 });
    const dark = canvas();
    widget.render?.(dark.context);
    expect(dark.fills).toEqual([]);

    deliver('brightness', 0.5);
    const lit = canvas();
    widget.render?.(lit.context);
    // 一层光晕（径向渐变）+ 一层灯芯（纯色）。
    expect(lit.fills).toHaveLength(2);
    expect(typeof lit.fills[0]).toBe('object');
    expect(lit.fills[1]).toMatch(/^rgba\(59, 130, 246, 0\.6\)$/);
  });

  it('越界与非法亮度被钳制或忽略', () => {
    const { widget, deliver } = mount(indicator, { width: 18, height: 26 });
    deliver('brightness', 5);
    const bright = canvas();
    widget.render?.(bright.context);
    expect(bright.fills[1]).toMatch(/^rgba\(59, 130, 246, 0\.95\)$/);

    deliver('brightness', Number.NaN);
    const unchanged = canvas();
    widget.render?.(unchanged.context);
    expect(unchanged.fills).toHaveLength(2);
  });
});

describe('背景图', () => {
  it('读到字节后按实例尺寸绘制位图', async () => {
    const bitmap = { width: 1068, height: 768, close: vi.fn() };
    const createImageBitmap = vi.fn(async () => bitmap);
    const original = globalThis.createImageBitmap;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = createImageBitmap;

    try {
      const { widget } = mount(image, {
        width: 1068,
        height: 768,
        props: { image: { src: 'assets/ct107d-board.webp', mode: 'file' } },
        readBinary: async () => new Uint8Array([82, 73, 70, 70]),
      });
      await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalled());

      const { images, context } = canvas();
      widget.render?.(context);
      expect(images).toEqual([{ x: 0, y: 0, width: 1068, height: 768 }]);
      widget.dispose?.();
      expect(bitmap.close).toHaveBeenCalled();
    } finally {
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = original;
    }
  });

  it('资源读取失败时画出占位提示而不是抛错', async () => {
    const { widget } = mount(image, {
      props: { image: { src: 'assets/missing.webp', mode: 'file' } },
      readBinary: async () => {
        throw new Error('missing');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { fillRects, context } = canvas();
    widget.render?.(context);
    expect(fillRects).toEqual(['rgba(248, 113, 113, 0.18)']);
  });
});
