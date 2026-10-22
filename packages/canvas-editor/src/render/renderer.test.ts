import type { CanvasDocument } from '@mica-js/core/canvas';
import type { WidgetLayer, WidgetLayers } from '@mica-js/widget';
import { describe, expect, it } from 'vitest';
import { canvasDocument, widget } from '../test-helpers';
import { DARK_CANVAS_THEME } from '../theme';
import { CanvasFrameRenderer, type CanvasFrame } from './renderer';

/** Records what the renderer does, so drawing rules are testable without a DOM. */
interface FakeContext {
  readonly calls: string[];
  readonly transforms: readonly number[][];
  readonly drawnImages: readonly unknown[][];
}

function createFakeCanvas(): { canvas: HTMLCanvasElement; context: FakeContext } {
  const calls: string[] = [];
  const transforms: number[][] = [];
  const drawnImages: unknown[][] = [];
  const methods: Record<string, (...args: unknown[]) => void> = {
    setTransform: (...args) => {
      transforms.push(args as number[]);
    },
    drawImage: (...args) => {
      drawnImages.push(args);
    },
    beginPath: () => calls.push('beginPath'),
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'),
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    setLineDash: () => {},
    arc: () => calls.push('arc'),
  };
  const target: Record<string, unknown> = { ...methods };
  const context2d = new Proxy(target, {
    get: (object, property) => object[String(property)],
    set: (object, property, value) => {
      object[String(property)] = value;
      return true;
    },
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context2d,
  } as unknown as HTMLCanvasElement;
  return { canvas, context: { calls, transforms, drawnImages } };
}

const emptyLayers: WidgetLayers = {
  list: () => [],
  get: () => undefined,
  subscribe: () => () => {},
};

function layer(instanceId: string, bitmap: ImageBitmap | undefined): WidgetLayer {
  return { instanceId, width: 100, height: 50, dpr: 1, bitmap, sequence: 1 };
}

function frame(overrides: Partial<CanvasFrame> = {}): CanvasFrame {
  return {
    document: canvasDocument(),
    layers: emptyLayers,
    previews: new Map(),
    selection: [],
    viewport: { x: 0, y: 0, scale: 1 },
    mode: 'edit',
    ...overrides,
  };
}

function createRenderer(gridSize = DARK_CANVAS_THEME.gridSize) {
  const fake = createFakeCanvas();
  const renderer = new CanvasFrameRenderer({
    canvas: fake.canvas,
    theme: { ...DARK_CANVAS_THEME, gridSize },
  });
  return { renderer, ...fake };
}

describe('CanvasFrameRenderer', () => {
  it.each([0, -10, Number.NaN])('draws no grid for a gridSize of %s', (gridSize) => {
    const { renderer, context } = createRenderer(gridSize);
    renderer.resize(200, 100, 1);

    // The historical infinite loop lived here: a non-positive step never reaches the cap.
    renderer.render(frame());

    expect(context.calls).not.toContain('stroke');
    // The background is still painted, so the surface never stays stale.
    expect(context.calls).toContain('fillRect');
  });

  it('draws minor and major grid lines for a positive gridSize', () => {
    const { renderer, context } = createRenderer(10);
    renderer.resize(200, 100, 1);
    renderer.render(frame());
    expect(context.calls.filter((call) => call === 'stroke')).toHaveLength(2);
  });

  it('scales the context by the device pixel ratio and the zoom', () => {
    const { renderer, context } = createRenderer();
    renderer.resize(100, 50, 2);
    renderer.render(frame({ viewport: { x: 10, y: 20, scale: 3 } }));

    expect(context.transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
    expect(context.transforms[1]).toEqual([6, 0, 0, 6, 20, 40]);
  });

  it('draws a bitmap at the instance geometry and a placeholder without one', () => {
    const document: CanvasDocument = canvasDocument(widget('a'), widget('b', { x: 200 }));
    const bitmap = { width: 100, height: 50 } as unknown as ImageBitmap;
    const layers: WidgetLayers = {
      list: () => [layer('b', bitmap)],
      get: () => undefined,
      subscribe: () => () => {},
    };
    const { renderer, context } = createRenderer();
    renderer.resize(400, 200, 1);

    renderer.render(frame({ document, layers }));

    // Only `b` has a frame; it is drawn in instance units, centered on the instance.
    expect(context.drawnImages).toEqual([[bitmap, -50, -25, 100, 50]]);
    // `a` has no layer yet, so it still gets a dashed placeholder outline.
    expect(context.calls).toContain('strokeRect');
  });

  it('draws handles only for a single selection', () => {
    const document = canvasDocument(widget('a'), widget('b', { x: 200 }));
    const { renderer, context } = createRenderer();
    renderer.resize(400, 200, 1);

    renderer.render(frame({ document, selection: ['a'] }));
    // Eight handle squares, the rotation knob and its connecting line.
    expect(context.calls.filter((call) => call === 'arc')).toHaveLength(1);
    expect(context.calls).toContain('fill');

    const multi = createRenderer();
    multi.renderer.resize(400, 200, 1);
    multi.renderer.render(frame({ document, selection: ['a', 'b'] }));
    expect(multi.context.calls).not.toContain('arc');
    expect(multi.context.calls).not.toContain('fill');
  });
});
