import {
  CANVAS_VERSION,
  type CanvasDocument,
  type CanvasWidgetInstance,
} from '@mica-js/document/canvas';
import type { WidgetInputEvent } from '@mica-js/widget';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanvasModel } from './model';
import {
  CANVAS_FIT_PADDING,
  CANVAS_IDENTITY_VIEWPORT,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CANVAS_WHEEL_ZOOM_RATE,
  CANVAS_ZOOM_FACTOR,
  canvasLocalToPoint,
  canvasPlacementBounds,
  canvasPlacementCorners,
  canvasPointToLocal,
  clampCanvasZoom,
  containsCanvasPoint,
  createCanvasView,
  documentToViewport,
  fitViewport,
  hitTestCanvasHandle,
  hitTestCanvasInstance,
  resizeCanvasPlacement,
  viewportToDocument,
  widgetPointFromCanvas,
  zoomViewportAt,
  type ICanvasFrame,
  type ICanvasView,
} from './view';

const ID_A = '3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13';
const ID_B = 'a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046';

function instance(id: string, overrides: Partial<CanvasWidgetInstance> = {}): CanvasWidgetInstance {
  return {
    id,
    widget: 'builtin:test',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    ...overrides,
  };
}

function documentWith(...widgets: readonly CanvasWidgetInstance[]): CanvasDocument {
  return { version: CANVAS_VERSION, widgets };
}

type Listener = (event: never) => void;

class FakeContext {
  readonly calls: { readonly name: string; readonly args: readonly unknown[] }[] = [];
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#record('setTransform', [a, b, c, d, e, f]);
  }

  save(): void {
    this.#record('save', []);
  }

  restore(): void {
    this.#record('restore', []);
  }

  translate(x: number, y: number): void {
    this.#record('translate', [x, y]);
  }

  rotate(radians: number): void {
    this.#record('rotate', [radians]);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.#record('fillRect', [x, y, width, height]);
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.#record('strokeRect', [x, y, width, height]);
  }

  drawImage(image: unknown, x: number, y: number, width: number, height: number): void {
    this.#record('drawImage', [image, x, y, width, height]);
  }

  setLineDash(segments: readonly number[]): void {
    this.#record('setLineDash', [segments]);
  }

  beginPath(): void {
    this.#record('beginPath', []);
  }

  moveTo(x: number, y: number): void {
    this.#record('moveTo', [x, y]);
  }

  lineTo(x: number, y: number): void {
    this.#record('lineTo', [x, y]);
  }

  stroke(): void {
    this.#record('stroke', []);
  }

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  #record(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }
}

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly ownerDocument: FakeDocument;
  readonly context = new FakeContext();
  readonly captured = new Set<number>();
  readonly #listeners = new Map<string, Set<Listener>>();
  className = '';
  tabIndex = -1;
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  #parent: FakeElement | undefined;

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
  }

  append(node: FakeElement): void {
    node.#parent = this;
    this.children.push(node);
  }

  remove(): void {
    const parent = this.#parent;
    if (parent === undefined) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.#parent = undefined;
  }

  addEventListener(type: string, listener: unknown): void {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: unknown): void {
    this.#listeners.get(type)?.delete(listener as Listener);
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  emit(type: string, event: object): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event as never);
    }
  }

  getContext(): FakeContext {
    return this.context;
  }

  focus(): void {}

  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captured.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId);
  }

  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } {
    return { left: 0, top: 0, width: this.clientWidth || 800, height: this.clientHeight || 600 };
  }
}

class FakeDocument {
  readonly defaultView = { devicePixelRatio: 1 };

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

interface IFakeResizeEntry {
  readonly contentRect: { readonly width: number; readonly height: number };
}

type ResizeCallback = (entries: readonly IFakeResizeEntry[]) => void;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: FakeElement[] = [];
  readonly callback: ResizeCallback;
  disconnected = false;

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: FakeElement): void {
    this.targets.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  fire(width: number, height: number): void {
    this.callback([{ contentRect: { width, height } }]);
  }
}

let restoreResizeObserver: () => void = () => undefined;

beforeEach(() => {
  const globals = globalThis as { ResizeObserver?: unknown };
  const previous = globals.ResizeObserver;
  FakeResizeObserver.instances = [];
  globals.ResizeObserver = FakeResizeObserver;
  restoreResizeObserver = () => {
    if (previous === undefined) {
      delete globals.ResizeObserver;
    } else {
      globals.ResizeObserver = previous;
    }
  };
});

afterEach(() => {
  restoreResizeObserver();
});

interface IHarnessOptions {
  readonly document?: CanvasDocument;
  readonly model?: CanvasModel;
  readonly readOnly?: boolean;
  readonly simulation?: boolean;
  /** Mutable mode flag, so a test can switch the view to simulation mid-gesture. */
  readonly simulationState?: { value: boolean };
  readonly frames?: ReadonlyMap<string, ICanvasFrame>;
  readonly devicePixelRatio?: number;
  readonly frameError?: unknown;
  readonly dispatchError?: unknown;
}

interface IDispatch {
  readonly instanceId: string;
  readonly event: WidgetInputEvent;
}

interface IHarness {
  readonly fakeDocument: FakeDocument;
  readonly container: FakeElement;
  readonly model: CanvasModel;
  readonly view: ICanvasView;
  readonly canvas: FakeElement;
  readonly context: FakeContext;
  readonly dispatches: IDispatch[];
  readonly errors: unknown[];
  dispose(): void;
}

function createHarness(options: IHarnessOptions = {}): IHarness {
  const fakeDocument = new FakeDocument();
  if (options.devicePixelRatio !== undefined) {
    fakeDocument.defaultView.devicePixelRatio = options.devicePixelRatio;
  }
  const container = fakeDocument.createElement('div');
  container.clientWidth = 400;
  container.clientHeight = 300;
  const model = options.model ?? new CanvasModel(options.document ?? documentWith(instance(ID_A)));
  const dispatches: IDispatch[] = [];
  const errors: unknown[] = [];
  const view = createCanvasView({
    container: container as unknown as HTMLElement,
    model,
    readOnly: options.readOnly ?? false,
    getFrame: (id) => {
      if (options.frameError !== undefined) throw options.frameError;
      return options.frames?.get(id);
    },
    onDispatch: (instanceId, event) => {
      dispatches.push({ instanceId, event });
      return options.dispatchError === undefined
        ? Promise.resolve()
        : Promise.reject(options.dispatchError);
    },
    isSimulation: () => options.simulationState?.value ?? options.simulation ?? false,
    onError: (error) => errors.push(error),
  });
  const canvas = container.children[0];
  if (canvas === undefined) {
    throw new Error('The view did not mount a canvas.');
  }
  return {
    fakeDocument,
    container,
    model,
    view,
    canvas,
    context: canvas.context,
    dispatches,
    errors,
    dispose() {
      view.dispose();
      model.dispose();
    },
  };
}

function pointer(init: {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId?: number;
  readonly button?: number;
  readonly buttons?: number;
}): PointerEvent {
  return {
    button: 0,
    buttons: 1,
    pointerId: 1,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    ...init,
  } as unknown as PointerEvent;
}

function key(init: {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    ...init,
  } as unknown as KeyboardEvent;
}

interface IFakeWheelEvent extends WheelEvent {
  prevented: boolean;
}

function wheel(init: {
  readonly clientX: number;
  readonly clientY: number;
  readonly deltaY: number;
  readonly deltaMode?: number;
}): IFakeWheelEvent {
  const event = {
    deltaMode: 0,
    deltaX: 0,
    deltaZ: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
    ...init,
  };
  return event as unknown as IFakeWheelEvent;
}

/** Document transform of the last painted frame: `[a, d, e, f]` from `setTransform`. */
function lastDocumentTransform(context: FakeContext): readonly unknown[] | undefined {
  const transforms = context.calls.filter((call) => call.name === 'setTransform');
  return transforms[transforms.length - 1]?.args;
}

function transformNumber(context: FakeContext, index: number): number {
  const value = lastDocumentTransform(context)?.[index];
  return typeof value === 'number' ? value : Number.NaN;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('canvas geometry', () => {
  it('maps document points into a rotated instance frame', () => {
    const placement = { x: 0, y: 0, width: 100, height: 50, rotation: 90 };

    const local = canvasPointToLocal(placement, { x: 50, y: 65 });
    expect(local.x).toBeCloseTo(40);
    expect(local.y).toBeCloseTo(0);

    const logical = widgetPointFromCanvas(placement, { x: 50, y: 65 });
    expect(logical.x).toBeCloseTo(90);
    expect(logical.y).toBeCloseTo(25);

    expect(containsCanvasPoint(placement, { x: 50, y: 65 })).toBe(true);
    expect(containsCanvasPoint(placement, { x: 50, y: 80 })).toBe(false);
  });

  it('hit-tests the topmost instance with inverse rotation', () => {
    const rotated = instance(ID_A, { rotation: 90 });
    const offset = instance(ID_B, { x: 200 });

    expect(hitTestCanvasInstance([rotated, offset], { x: 50, y: 65 })?.id).toBe(ID_A);
    expect(hitTestCanvasInstance([rotated, offset], { x: 300, y: 25 })?.id).toBe(ID_B);
    expect(hitTestCanvasInstance([rotated, offset], { x: 150, y: 25 })).toBeUndefined();

    const stacked = instance(ID_B);
    expect(hitTestCanvasInstance([instance(ID_A), stacked], { x: 50, y: 25 })?.id).toBe(ID_B);
  });

  it('finds corner handles and ignores the instance interior', () => {
    const placement = { x: 0, y: 0, width: 100, height: 50, rotation: 0 };

    expect(hitTestCanvasHandle(placement, { x: 100, y: 50 })).toBe('se');
    expect(hitTestCanvasHandle(placement, { x: 0, y: 0 })).toBe('nw');
    expect(hitTestCanvasHandle(placement, { x: 60, y: 25 })).toBeUndefined();
  });

  it('resizes a corner while pinning the opposite corner', () => {
    const placement = { x: 10, y: 20, width: 100, height: 60, rotation: 30 };
    const pointerPoint = canvasLocalToPoint(placement, { x: 200, y: 150 });

    const resized = resizeCanvasPlacement(placement, 'se', pointerPoint);
    const before = canvasPlacementCorners(placement)[0];
    const after = canvasPlacementCorners(resized)[0];

    expect(resized.width).toBeCloseTo(250);
    expect(resized.height).toBeCloseTo(180);
    expect(resized.rotation).toBe(30);
    expect(after?.x).toBeCloseTo(before?.x ?? Number.NaN);
    expect(after?.y).toBeCloseTo(before?.y ?? Number.NaN);
  });

  it('clamps a resize to the minimum size', () => {
    const placement = { x: 0, y: 0, width: 100, height: 50, rotation: 0 };
    const resized = resizeCanvasPlacement(placement, 'se', { x: -1000, y: -1000 }, 2);

    expect(resized.width).toBe(2);
    expect(resized.height).toBe(2);
  });
});

describe('createCanvasView', () => {
  it('mounts its own canvas and sizes the backing store', () => {
    const harness = createHarness();

    expect(harness.container.children).toHaveLength(1);
    expect(harness.canvas.className).toBe('mica-canvas');
    expect(harness.canvas.tabIndex).toBe(0);
    expect(harness.canvas.width).toBe(400);
    expect(harness.canvas.height).toBe(300);
    expect(harness.container.style).toEqual({});

    harness.dispose();
  });

  it('scales the backing store by the device pixel ratio', () => {
    const harness = createHarness({ devicePixelRatio: 2 });

    expect(harness.canvas.width).toBe(800);
    expect(harness.canvas.height).toBe(600);

    harness.fakeDocument.defaultView.devicePixelRatio = 1;
    harness.view.render();
    expect(harness.canvas.width).toBe(400);
    expect(harness.canvas.height).toBe(300);

    harness.dispose();
  });

  it('follows container resizes through the ResizeObserver', () => {
    const harness = createHarness();
    const observer = FakeResizeObserver.instances[0];
    expect(observer).toBeDefined();
    expect(observer?.targets).toContain(harness.container);

    observer?.fire(120, 90);
    expect(harness.canvas.width).toBe(120);
    expect(harness.canvas.height).toBe(90);

    harness.dispose();
    expect(observer?.disconnected).toBe(true);
  });

  it('draws frames in document order and placeholders for missing frames', () => {
    const bitmap = {} as ImageBitmap;
    const frames = new Map<string, ICanvasFrame>([
      [ID_A, { bitmap, width: 100, height: 50, dpr: 1 }],
    ]);
    const harness = createHarness({
      document: documentWith(instance(ID_A), instance(ID_B, { x: 120 })),
      frames,
    });

    const drawCalls = harness.context.calls.filter((call) => call.name === 'drawImage');
    expect(drawCalls).toHaveLength(1);
    expect(drawCalls[0]?.args[0]).toBe(bitmap);
    expect(harness.context.count('strokeRect')).toBe(1);

    const translates = harness.context.calls
      .filter((call) => call.name === 'translate')
      .map((call) => call.args);
    expect(translates).toEqual([
      [50, 25],
      [170, 25],
    ]);

    harness.dispose();
  });

  it('reports a throwing frame source and keeps drawing placeholders', () => {
    const failure = new Error('frame unavailable');
    const harness = createHarness({ frameError: failure });

    expect(harness.errors).toContain(failure);
    expect(harness.context.count('strokeRect')).toBeGreaterThan(0);

    harness.dispose();
  });

  it('renders again when the model commits', async () => {
    const harness = createHarness();
    const before = harness.context.calls.length;

    await harness.model.apply({ type: 'remove-instance', instanceId: ID_A });

    expect(harness.context.calls.length).toBeGreaterThan(before);
    harness.dispose();
  });

  it('selects the instance under the pointer and deletes it', async () => {
    const harness = createHarness({
      document: documentWith(instance(ID_A, { rotation: 90 }), instance(ID_B, { x: 200 })),
    });

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 65 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 50, clientY: 65, buttons: 0 }));
    harness.canvas.emit('keydown', key({ key: 'Delete' }));
    await tick();

    expect(harness.model.document.widgets.map((widget) => widget.id)).toEqual([ID_B]);
    harness.dispose();
  });

  it('drags the selected instance and commits one placement', async () => {
    const harness = createHarness();

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 25 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 70, clientY: 40 }));
    expect(harness.model.document.widgets[0]?.x).toBe(0);

    harness.canvas.emit('pointerup', pointer({ clientX: 70, clientY: 40, buttons: 0 }));
    await tick();

    expect(harness.model.document.widgets[0]).toMatchObject({ x: 20, y: 15 });
    expect(harness.dispatches).toHaveLength(0);
    harness.dispose();
  });

  it('resizes from a corner handle and commits one placement', async () => {
    const harness = createHarness();

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 25, pointerId: 1 }));
    harness.canvas.emit(
      'pointerup',
      pointer({ clientX: 50, clientY: 25, pointerId: 1, buttons: 0 }),
    );
    harness.canvas.emit('pointerdown', pointer({ clientX: 100, clientY: 50, pointerId: 2 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 150, clientY: 80, pointerId: 2 }));
    harness.canvas.emit(
      'pointerup',
      pointer({ clientX: 150, clientY: 80, pointerId: 2, buttons: 0 }),
    );
    await tick();

    expect(harness.model.document.widgets[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 150,
      height: 80,
      rotation: 0,
    });
    harness.dispose();
  });

  it('reports a rejected placement and keeps the committed geometry', async () => {
    let rejectNext = false;
    const model = new CanvasModel(documentWith(instance(ID_A)), async () => {
      if (rejectNext) throw new Error('sync failed');
    });
    const harness = createHarness({ model });
    rejectNext = true;

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 25 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 70, clientY: 40 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 70, clientY: 40, buttons: 0 }));
    await tick();

    expect(harness.model.document.widgets[0]?.x).toBe(0);
    expect(harness.errors[0]).toBeInstanceOf(Error);
    expect((harness.errors[0] as Error).message).toBe('sync failed');
    harness.dispose();
  });

  it('blocks edits when read-only but still selects', async () => {
    const harness = createHarness({ readOnly: true });

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 25 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 80, clientY: 40 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 80, clientY: 40, buttons: 0 }));
    harness.canvas.emit('keydown', key({ key: 'Delete' }));
    harness.canvas.emit('keydown', key({ key: 'z', ctrlKey: true }));
    await tick();

    expect(harness.model.document.widgets).toHaveLength(1);
    expect(harness.model.document.widgets[0]?.x).toBe(0);
    harness.dispose();
  });

  it('blocks keyboard edits in simulation mode', async () => {
    const simulationState = { value: false };
    const harness = createHarness({ simulationState });

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 25 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 50, clientY: 25, buttons: 0 }));
    simulationState.value = true;

    harness.canvas.emit('keydown', key({ key: 'Delete' }));
    harness.canvas.emit('keydown', key({ key: 'z', ctrlKey: true }));
    harness.canvas.emit('keydown', key({ key: 'y', ctrlKey: true }));
    await tick();

    expect(harness.model.document.widgets).toHaveLength(1);
    expect(harness.model.document.widgets[0]?.x).toBe(0);
    harness.dispose();
  });

  it('cancels a pending edit when the mode switches to simulation', async () => {
    const simulationState = { value: false };
    const harness = createHarness({ simulationState });

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 25 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 70, clientY: 40 }));
    simulationState.value = true;
    harness.canvas.emit('pointerup', pointer({ clientX: 70, clientY: 40, buttons: 0 }));
    await tick();

    expect(harness.model.document.widgets[0]?.x).toBe(0);
    expect(harness.dispatches).toHaveLength(0);
    harness.dispose();
  });

  it('undoes and redoes from the keyboard', async () => {
    const harness = createHarness();
    await harness.model.apply({ type: 'remove-instance', instanceId: ID_A });
    expect(harness.model.document.widgets).toHaveLength(0);

    harness.canvas.emit('keydown', key({ key: 'z', ctrlKey: true }));
    await tick();
    expect(harness.model.document.widgets).toHaveLength(1);

    harness.canvas.emit('keydown', key({ key: 'z', ctrlKey: true, shiftKey: true }));
    await tick();
    expect(harness.model.document.widgets).toHaveLength(0);

    harness.canvas.emit('keydown', key({ key: 'z', ctrlKey: true }));
    await tick();
    expect(harness.model.document.widgets).toHaveLength(1);

    harness.canvas.emit('keydown', key({ key: 'y', ctrlKey: true }));
    await tick();
    expect(harness.model.document.widgets).toHaveLength(0);
    harness.dispose();
  });

  it('forwards simulation pointer input with widget-local coordinates', async () => {
    const harness = createHarness({ simulation: true });

    harness.canvas.emit('pointerdown', pointer({ clientX: 25, clientY: 20 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 30, clientY: 25 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 30, clientY: 25, buttons: 0 }));
    await tick();

    expect(harness.dispatches.map((dispatch) => dispatch.event.type)).toEqual([
      'pointerdown',
      'pointermove',
      'pointerup',
    ]);
    expect(harness.dispatches.every((dispatch) => dispatch.instanceId === ID_A)).toBe(true);
    expect(harness.dispatches[0]?.event).toMatchObject({ x: 25, y: 20, button: 0, buttons: 1 });
    expect(harness.dispatches[1]?.event).toMatchObject({ x: 30, y: 25 });
    expect(harness.model.document.widgets[0]?.x).toBe(0);
    harness.dispose();
  });

  it('maps rotated simulation input into the widget frame', () => {
    const harness = createHarness({
      simulation: true,
      document: documentWith(instance(ID_A, { rotation: 90 })),
    });

    harness.canvas.emit('pointerdown', pointer({ clientX: 50, clientY: 65 }));

    expect(harness.dispatches[0]?.event.x).toBeCloseTo(90);
    expect(harness.dispatches[0]?.event.y).toBeCloseTo(25);
    harness.dispose();
  });

  it('forwards simulation input while read-only and never in edit mode', async () => {
    const readOnly = createHarness({ simulation: true, readOnly: true });
    readOnly.canvas.emit('pointerdown', pointer({ clientX: 25, clientY: 20 }));
    readOnly.canvas.emit('pointerup', pointer({ clientX: 25, clientY: 20, buttons: 0 }));
    expect(readOnly.dispatches).toHaveLength(2);
    readOnly.dispose();

    const edit = createHarness();
    edit.canvas.emit('pointerdown', pointer({ clientX: 25, clientY: 20 }));
    edit.canvas.emit('pointerup', pointer({ clientX: 25, clientY: 20, buttons: 0 }));
    await tick();
    expect(edit.dispatches).toHaveLength(0);
    edit.dispose();
  });

  it('reports dispatch failures without stopping input', async () => {
    const failure = new Error('dispatch failed');
    const harness = createHarness({ simulation: true, dispatchError: failure });

    harness.canvas.emit('pointerdown', pointer({ clientX: 25, clientY: 20 }));
    await tick();
    expect(harness.errors).toContain(failure);

    harness.canvas.emit('pointerup', pointer({ clientX: 25, clientY: 20, buttons: 0 }));
    harness.canvas.emit('pointerdown', pointer({ clientX: 25, clientY: 20, pointerId: 2 }));
    await tick();
    expect(harness.dispatches).toHaveLength(3);
    expect(harness.errors).toHaveLength(3);
    harness.dispose();
  });

  it('disposes its element, listeners and observer', () => {
    const harness = createHarness();
    const observer = FakeResizeObserver.instances[0];
    const calls = harness.context.calls.length;

    harness.dispose();

    expect(harness.container.children).toHaveLength(0);
    expect(observer?.disconnected).toBe(true);
    expect(harness.canvas.listenerCount('pointerdown')).toBe(0);

    harness.view.render();
    expect(harness.context.calls.length).toBe(calls);
  });
});

describe('canvas viewport', () => {
  it('keeps the document point under the zoom anchor', () => {
    const anchor = { x: 100, y: 80 };
    const anchorPoint = viewportToDocument(CANVAS_IDENTITY_VIEWPORT, anchor);
    const zoomed = zoomViewportAt(CANVAS_IDENTITY_VIEWPORT, anchor, 2);

    expect(zoomed.scale).toBe(2);
    const placed = documentToViewport(zoomed, anchorPoint);
    expect(placed.x).toBeCloseTo(anchor.x);
    expect(placed.y).toBeCloseTo(anchor.y);
  });

  it('clamps the zoom range', () => {
    expect(clampCanvasZoom(100)).toBe(CANVAS_MAX_ZOOM);
    expect(clampCanvasZoom(0.001)).toBe(CANVAS_MIN_ZOOM);
    expect(clampCanvasZoom(0)).toBe(CANVAS_MIN_ZOOM);
    expect(clampCanvasZoom(Number.NaN)).toBe(CANVAS_MIN_ZOOM);
    expect(zoomViewportAt(CANVAS_IDENTITY_VIEWPORT, { x: 0, y: 0 }, 1e6).scale).toBe(
      CANVAS_MAX_ZOOM,
    );
  });

  it('fits bounds with padding and resets for empty bounds', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 50 };
    const fitted = fitViewport(bounds, 400, 300);

    const expectedScale = Math.min(
      (400 - CANVAS_FIT_PADDING * 2) / bounds.width,
      (300 - CANVAS_FIT_PADDING * 2) / bounds.height,
    );
    expect(fitted.scale).toBeCloseTo(expectedScale);

    const center = documentToViewport(fitted, { x: 50, y: 25 });
    expect(center.x).toBeCloseTo(200);
    expect(center.y).toBeCloseTo(150);

    const topLeft = documentToViewport(fitted, { x: 0, y: 0 });
    expect(topLeft.x).toBeCloseTo(CANVAS_FIT_PADDING);
    expect(fitViewport(undefined, 400, 300)).toEqual(CANVAS_IDENTITY_VIEWPORT);
  });

  it('zooms around the wheel pointer, prevents the page scroll and clamps the zoom', () => {
    const harness = createHarness({
      simulation: true,
      document: documentWith(instance(ID_A, { width: 1000, height: 500 })),
    });

    const zoom = wheel({ clientX: 100, clientY: 80, deltaY: -100 });
    harness.canvas.emit('wheel', zoom);

    expect(zoom.prevented).toBe(true);
    expect(transformNumber(harness.context, 0)).toBeCloseTo(
      Math.exp(-(-100) * CANVAS_WHEEL_ZOOM_RATE),
    );

    harness.canvas.emit('pointerdown', pointer({ clientX: 100, clientY: 80 }));
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.event.x).toBeCloseTo(100);
    expect(harness.dispatches[0]?.event.y).toBeCloseTo(80);

    harness.canvas.emit('wheel', wheel({ clientX: 200, clientY: 150, deltaY: -1e6 }));
    expect(transformNumber(harness.context, 0)).toBe(CANVAS_MAX_ZOOM);
    harness.dispose();
  });

  it('hit-tests and drags in world units after zooming', async () => {
    const harness = createHarness({
      document: documentWith(instance(ID_A, { width: 1000, height: 500 })),
    });
    harness.view.zoomIn();

    harness.canvas.emit('pointerdown', pointer({ clientX: 200, clientY: 150 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 212, clientY: 162 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 212, clientY: 162, buttons: 0 }));
    await tick();

    expect(harness.model.document.widgets[0]).toMatchObject({ x: 10, y: 10 });
    harness.dispose();
  });

  it('exposes zoomIn, zoomOut, resetView and fitView without touching the model', () => {
    const harness = createHarness({ simulation: true });

    harness.view.zoomIn();
    harness.view.zoomOut();
    harness.view.fitView();
    harness.view.resetView();

    expect(harness.model.document.widgets).toHaveLength(1);
    expect(harness.model.canUndo).toBe(false);

    harness.canvas.emit('pointerdown', pointer({ clientX: 25, clientY: 20 }));
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.event).toMatchObject({ x: 25, y: 20 });
    harness.dispose();
  });

  it('resets the view for an empty canvas', () => {
    const harness = createHarness({ document: { version: CANVAS_VERSION, widgets: [] } });

    harness.view.zoomIn();
    harness.view.fitView();

    expect(transformNumber(harness.context, 0)).toBe(1);
    expect(transformNumber(harness.context, 3)).toBe(1);
    harness.dispose();
  });

  it('fits rotated widget bounds with padding', () => {
    const widget = instance(ID_A, { rotation: 90 });
    const harness = createHarness({ simulation: true, document: documentWith(widget) });

    harness.view.fitView();

    const expected = fitViewport(canvasPlacementBounds(widget), 400, 300);
    const probe = documentToViewport(expected, { x: 50, y: 70 });
    harness.canvas.emit('pointerdown', pointer({ clientX: probe.x, clientY: probe.y }));

    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.event.x).toBeCloseTo(95);
    expect(harness.dispatches[0]?.event.y).toBeCloseTo(25);
    harness.dispose();
  });

  it('pans with Space + left drag without forwarding or editing', () => {
    const harness = createHarness({
      simulation: true,
      document: documentWith(instance(ID_A, { width: 1000, height: 500 })),
    });

    harness.canvas.emit('keydown', key({ key: ' ', code: 'Space' }));
    harness.canvas.emit('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    harness.canvas.emit('pointermove', pointer({ clientX: 150, clientY: 130 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 150, clientY: 130, buttons: 0 }));
    harness.canvas.emit('keyup', key({ key: ' ', code: 'Space' }));

    expect(harness.dispatches).toHaveLength(0);
    expect(harness.model.canUndo).toBe(false);
    expect(harness.model.document.widgets[0]?.x).toBe(0);

    harness.canvas.emit('pointerdown', pointer({ clientX: 150, clientY: 130 }));
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.event.x).toBeCloseTo(100);
    expect(harness.dispatches[0]?.event.y).toBeCloseTo(100);
    harness.dispose();
  });

  it('pans with the middle button in read-only simulation without dispatching', () => {
    const harness = createHarness({
      simulation: true,
      readOnly: true,
      document: documentWith(instance(ID_A, { width: 1000, height: 500 })),
    });

    harness.canvas.emit(
      'pointerdown',
      pointer({ clientX: 100, clientY: 100, button: 1, buttons: 4 }),
    );
    harness.canvas.emit(
      'pointermove',
      pointer({ clientX: 140, clientY: 120, button: 1, buttons: 4 }),
    );
    harness.canvas.emit(
      'pointerup',
      pointer({ clientX: 140, clientY: 120, button: 1, buttons: 0 }),
    );

    expect(harness.dispatches).toHaveLength(0);
    expect(harness.model.document.widgets[0]?.x).toBe(0);
    expect(harness.model.canUndo).toBe(false);

    harness.canvas.emit('pointerdown', pointer({ clientX: 140, clientY: 120 }));
    harness.canvas.emit('pointerup', pointer({ clientX: 140, clientY: 120, buttons: 0 }));
    expect(harness.dispatches).toHaveLength(2);
    expect(harness.dispatches[0]?.event.x).toBeCloseTo(100);
    expect(harness.dispatches[0]?.event.y).toBeCloseTo(100);

    harness.view.zoomIn();
    harness.view.zoomOut();
    harness.view.fitView();
    harness.view.resetView();
    expect(harness.model.document.widgets[0]?.x).toBe(0);
    harness.dispose();
  });

  it('cancels a pan cleanly and releases the pointer capture', () => {
    const harness = createHarness({
      simulation: true,
      document: documentWith(instance(ID_A, { width: 1000, height: 500 })),
    });

    harness.canvas.emit(
      'pointerdown',
      pointer({ clientX: 100, clientY: 100, button: 1, buttons: 4 }),
    );
    harness.canvas.emit(
      'pointermove',
      pointer({ clientX: 140, clientY: 120, button: 1, buttons: 4 }),
    );
    harness.canvas.emit(
      'pointercancel',
      pointer({ clientX: 140, clientY: 120, button: 1, buttons: 0 }),
    );

    expect(harness.canvas.captured.size).toBe(0);
    expect(harness.dispatches).toHaveLength(0);

    harness.canvas.emit('pointerdown', pointer({ clientX: 90, clientY: 45 }));
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.event.x).toBeCloseTo(50);
    expect(harness.dispatches[0]?.event.y).toBeCloseTo(25);
    harness.dispose();
  });

  it('applies device pixel ratio and zoom in one document transform', () => {
    const harness = createHarness({ devicePixelRatio: 2 });
    harness.view.zoomIn();

    expect(transformNumber(harness.context, 0)).toBeCloseTo(2 * CANVAS_ZOOM_FACTOR);
    expect(transformNumber(harness.context, 3)).toBeCloseTo(2 * CANVAS_ZOOM_FACTOR);
    harness.dispose();
  });
});
