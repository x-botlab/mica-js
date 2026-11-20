import { describe, expect, it, vi } from 'vitest';
import { timePs } from '@mica-js/core';
import type { Event } from '@mica-js/core/lifecycle';
import type { Value } from '@mica-js/document/fused';
import type { IFusedAudio, IFusedModelClient } from '@mica-js/editor/fused/runtime';
import type { ModelEvent } from '@mica-js/sdk/fused';
import { createBoardView, type BoardView, type BoardViewEvent } from '../device/src/view2d.js';
import {
  BOARD_SIZE_MM,
  JUMPERS,
  J13,
  J2,
  J2_TX,
  J3,
  J5,
  J6,
  KEYS,
  MM_PER_PX,
  PHOTO_BOUNDS,
  PHOTO_ORIGIN,
  POTENTIOMETERS,
  contains,
  jumperKnobRect,
  keyLayout,
  potentiometerSlider,
  potentiometerSliderKnob,
  toLocalPoint,
  toPhotoPoint,
  type PotentiometerSliderLayout,
  type Rect,
} from '../device/src/board-layout.js';
import {
  JUMPER_DESIGNATORS,
  KEY_DESIGNATORS,
  createBoardStateStore,
  type BoardSignal,
  type BoardSnapshot,
  type JumperDesignator,
  type KeyDesignator,
} from '../device/src/board-state.js';

/**
 * 整板 View2D 的最小行为基线：绘制只读取缓存、热区调用模型方法、抬起释放具体按键、
 * 初始化查询不覆盖较新事件、跳线呈现真实 1-2/2-3，以及 dispose 与异步失败可观察。
 */

interface SwitchCall {
  readonly designator: string;
  readonly pressed: boolean;
}

interface JumperCall {
  readonly designator: string;
  readonly closed: boolean;
  readonly channel?: number;
}

interface SnapshotOptions {
  readonly displays?: {
    readonly DS1: readonly number[];
    readonly DS2: readonly number[];
  };
  readonly leds?: readonly number[];
  readonly relay?: boolean;
  readonly buzzer?: boolean;
  readonly pressed?: readonly KeyDesignator[];
  readonly jumpers?: Partial<Record<JumperDesignator, boolean>>;
  readonly potentiometers?: Partial<BoardSnapshot['potentiometers']>;
}

function snapshotOf(options: SnapshotOptions = {}): BoardSnapshot {
  const switches = Object.fromEntries(
    KEY_DESIGNATORS.map((designator) => [designator, false]),
  ) as Record<KeyDesignator, boolean>;
  for (const designator of options.pressed ?? []) switches[designator] = true;
  const jumpers = Object.fromEntries(
    JUMPER_DESIGNATORS.map((designator) => [designator, designator !== 'J2Tx']),
  ) as Record<JumperDesignator, boolean>;
  Object.assign(jumpers, options.jumpers);
  return {
    displays: {
      DS1: [...(options.displays?.DS1 ?? [0, 0, 0, 0])],
      DS2: [...(options.displays?.DS2 ?? [0, 0, 0, 0])],
    },
    leds: [...(options.leds ?? Array.from({ length: 8 }, () => 0))],
    relay: options.relay ?? false,
    buzzer: options.buzzer ?? false,
    switches,
    jumpers,
    potentiometers: { RB2: 0, RB3: 0.5, RB4: 0, ...options.potentiometers },
  };
}

interface HarnessOptions {
  readonly snapshot?: BoardSnapshot;
  readonly getSnapshot?: () => Promise<Value>;
  readonly rejectSwitch?: Error;
  readonly rejectJumper?: Error;
}

function booleanRecordValue(record: Readonly<Record<string, boolean>>): Value {
  const value: Record<string, Value> = {};
  for (const [key, entry] of Object.entries(record)) value[key] = entry;
  return value;
}

function snapshotValue(snapshot: BoardSnapshot): Value {
  return {
    displays: {
      DS1: [...snapshot.displays.DS1],
      DS2: [...snapshot.displays.DS2],
    },
    leds: [...snapshot.leds],
    relay: snapshot.relay,
    buzzer: snapshot.buzzer,
    switches: booleanRecordValue(snapshot.switches),
    jumpers: booleanRecordValue(snapshot.jumpers),
    pcf8591: { analog: [0, 0, 0, snapshot.potentiometers.RB2] },
    ne555: { position: snapshot.potentiometers.RB3 },
    amplifier: { position: snapshot.potentiometers.RB4 },
  };
}

interface ModelHarness {
  readonly model: IFusedModelClient;
  readonly switchCalls: SwitchCall[];
  readonly jumperCalls: JumperCall[];
  readonly potentiometerCalls: [method: string, params: Value][];
  emit(signal: BoardSignal): void;
  listenerCount(): number;
  subscriptionDisposals(): number;
}

function parameterRecord(params: Value, label: string): Readonly<Record<string, Value>> {
  if (
    typeof params !== 'object' ||
    params === null ||
    Array.isArray(params) ||
    params instanceof Uint8Array
  ) {
    throw new TypeError(`${label} expects an object.`);
  }
  return params as Readonly<Record<string, Value>>;
}

function harness(options: HarnessOptions = {}): ModelHarness {
  const snapshot = options.snapshot ?? snapshotOf();
  const switchCalls: SwitchCall[] = [];
  const jumperCalls: JumperCall[] = [];
  const potentiometerCalls: ModelHarness['potentiometerCalls'] = [];
  const listeners = new Set<(event: ModelEvent<Value>) => void>();
  let disposals = 0;
  let sequence = 0;

  const onDidSignal: Event<ModelEvent<Value>> = (listener) => {
    listeners.add(listener);
    return {
      dispose() {
        listeners.delete(listener);
        disposals += 1;
      },
    };
  };

  const model: IFusedModelClient = {
    methods: {
      async setSwitch(params) {
        const record = parameterRecord(params, 'setSwitch');
        const designator = record['designator'];
        const pressed = record['pressed'];
        if (typeof designator !== 'string' || typeof pressed !== 'boolean') {
          throw new TypeError('setSwitch expects { designator, pressed }.');
        }
        switchCalls.push({ designator, pressed });
        if (options.rejectSwitch !== undefined) throw options.rejectSwitch;
        return null;
      },
      async setJumper(params) {
        const record = parameterRecord(params, 'setJumper');
        const designator = record['designator'];
        const closed = record['closed'];
        const channel = record['channel'];
        if (
          typeof designator !== 'string' ||
          typeof closed !== 'boolean' ||
          (channel !== undefined && typeof channel !== 'number')
        ) {
          throw new TypeError('setJumper expects { designator, closed, channel? }.');
        }
        jumperCalls.push({ designator, closed, ...(channel === undefined ? {} : { channel }) });
        if (options.rejectJumper !== undefined) throw options.rejectJumper;
        return null;
      },
      async getSnapshot() {
        return options.getSnapshot === undefined
          ? snapshotValue(snapshot)
          : await options.getSnapshot();
      },
      async setAnalogInput(params) {
        potentiometerCalls.push(['setAnalogInput', params]);
        return null;
      },
      async setWiper(params) {
        potentiometerCalls.push(['setWiper', params]);
        return null;
      },
      async setFrequencyWiper(params) {
        potentiometerCalls.push(['setFrequencyWiper', params]);
        return null;
      },
    },
    events: { onDidSignal },
  };

  return {
    model,
    switchCalls,
    jumperCalls,
    potentiometerCalls,
    emit(signal) {
      sequence += 1;
      const event: ModelEvent<Value> = {
        value: { designator: signal.designator, port: signal.port, value: signal.value },
        simTime: timePs(0),
        sequence,
      };
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
    subscriptionDisposals: () => disposals,
  };
}

interface PaintPoint {
  readonly x: number;
  readonly y: number;
}

interface StrokeRecord {
  readonly style: string;
  readonly points: readonly PaintPoint[];
}

interface EllipseRecord extends PaintPoint {
  readonly radiusX: number;
  readonly radiusY: number;
  readonly style: string;
}

interface FillRectRecord extends PaintPoint {
  readonly width: number;
  readonly height: number;
  readonly style: string;
}

interface RoundRectRecord extends FillRectRecord {
  readonly operation: 'fill' | 'stroke';
}

class FakeGradient {
  readonly stops: string[] = [];

  addColorStop(_offset: number, color: string): void {
    this.stops.push(color);
  }
}

class FakeCanvas {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  readonly fills: string[] = [];
  readonly strokes: StrokeRecord[] = [];
  readonly gradients: FakeGradient[] = [];
  readonly ellipses: EllipseRecord[] = [];
  readonly rectangles: FillRectRecord[] = [];
  readonly rounded: RoundRectRecord[] = [];
  readonly texts: string[] = [];
  /** 宿主把器件局部 mm 映射到照片像素；断言仍按照片坐标，变换只做记录。 */
  readonly scaleCalls: [number, number][] = [];
  readonly translateCalls: [number, number][] = [];
  private points: PaintPoint[] = [];
  private pendingRound: FillRectRecord | undefined;

  save(): void {}
  restore(): void {}
  scale(x: number, y: number): void {
    this.scaleCalls.push([x, y]);
  }
  translate(x: number, y: number): void {
    this.translateCalls.push([x, y]);
  }
  beginPath(): void {
    this.points = [];
    this.pendingRound = undefined;
  }
  closePath(): void {}
  moveTo(x: number, y: number): void {
    this.points = [{ x, y }];
  }
  lineTo(x: number, y: number): void {
    this.points.push({ x, y });
  }
  arc(x: number, y: number): void {
    this.points.push({ x, y });
  }
  ellipse(x: number, y: number, radiusX: number, radiusY: number): void {
    this.ellipses.push({ x, y, radiusX, radiusY, style: String(this.fillStyle) });
  }
  roundRect(x: number, y: number, width: number, height: number): void {
    this.pendingRound = { x, y, width, height, style: '' };
  }
  fill(): void {
    this.fills.push(String(this.fillStyle));
    if (this.pendingRound !== undefined)
      this.rounded.push({ ...this.pendingRound, style: String(this.fillStyle), operation: 'fill' });
  }
  stroke(): void {
    this.strokes.push({ style: String(this.strokeStyle), points: [...this.points] });
    if (this.pendingRound !== undefined)
      this.rounded.push({
        ...this.pendingRound,
        style: String(this.strokeStyle),
        operation: 'stroke',
      });
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.rectangles.push({ x, y, width, height, style: String(this.fillStyle) });
  }
  fillText(text: string): void {
    this.texts.push(text);
  }
  createRadialGradient(): CanvasGradient {
    const gradient = new FakeGradient();
    this.gradients.push(gradient);
    return gradient as unknown as CanvasGradient;
  }
}

type AudioTone = ReturnType<IFusedAudio['tone']>;

function audioHarness() {
  const set = vi.fn<AudioTone['set']>();
  const stop = vi.fn<AudioTone['stop']>();
  const ended: AudioTone['ended'] = Promise.resolve({ reason: 'disposed' });
  const tone: AudioTone = { id: 'tone', ended, set, stop };
  const createTone = vi.fn<IFusedAudio['tone']>(() => tone);
  return { audio: { tone: createTone }, createTone, set, stop };
}

function mount(model?: IFusedModelClient, audio?: Pick<IFusedAudio, 'tone'>) {
  let invalidations = 0;
  const view = createBoardView({
    model,
    ...(audio === undefined ? {} : { audio }),
    invalidate() {
      invalidations += 1;
    },
  });
  return { view, invalidations: () => invalidations };
}

function paint(view: BoardView): FakeCanvas {
  const canvas = new FakeCanvas();
  view.renderOverlay(canvas as unknown as OffscreenCanvasRenderingContext2D);
  return canvas;
}

function pointer(type: BoardViewEvent['type'], position: PaintPoint, button = 0): BoardViewEvent {
  // 测试沿用照片像素测量点；宿主交给 View2D 的是器件局部 mm。
  return {
    type,
    position: toLocalPoint(position),
    button,
    buttons: type === 'pointerup' ? 0 : 1,
  };
}

function keyCenter(designator: KeyDesignator): PaintPoint {
  const { x, y, width, height } = keyLayout(designator);
  return { x: x + width / 2, y: y + height / 2 };
}

function center(rect: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): PaintPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function filledRoundRect(
  canvas: FakeCanvas,
  rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): RoundRectRecord | undefined {
  return canvas.rounded.find(
    (entry) =>
      entry.operation === 'fill' &&
      entry.x === rect.x &&
      entry.y === rect.y &&
      entry.width === rect.width &&
      entry.height === rect.height,
  );
}

function intersects(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function sliderFor(designator: PotentiometerSliderLayout['designator']) {
  const layout = POTENTIOMETERS.find((entry) => entry.designator === designator);
  if (layout === undefined) throw new Error(`Missing potentiometer layout: ${designator}`);
  return potentiometerSlider(layout);
}

function sliderPoint(slider: PotentiometerSliderLayout, position: number): PaintPoint {
  return { x: slider.track.x + position * slider.track.width, y: center(slider.track).y };
}

async function click(view: BoardView, point: PaintPoint): Promise<void> {
  await view.input(pointer('pointerdown', point));
  await view.input(pointer('pointerup', point));
}

describe('CT107D View2D 绘制', () => {
  it('绘制前把器件局部 mm 换成照片像素', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const canvas = paint(view);
    // 宿主画布是局部 mm；叠层按照片像素绘制，照片与物理板外形保持同一比例。
    expect(canvas.scaleCalls).toEqual([[MM_PER_PX, MM_PER_PX]]);
    expect(canvas.translateCalls).toEqual([[-PHOTO_ORIGIN.x, -PHOTO_ORIGIN.y]]);
    expect(toLocalPoint(toPhotoPoint({ x: 41.5, y: 12.25 }))).toEqual({ x: 41.5, y: 12.25 });
    // 照片左上角就是板外形原点，右下角就是几何声明的板尺寸。
    expect(toLocalPoint(PHOTO_ORIGIN)).toEqual({ x: 0, y: 0 });
    const corner = toLocalPoint({ x: PHOTO_ORIGIN.x + 863, y: PHOTO_ORIGIN.y + 617 });
    expect(corner.x).toBeCloseTo(BOARD_SIZE_MM.width, 5);
    expect(corner.y).toBeCloseTo(BOARD_SIZE_MM.height, 5);
  });

  it('绘制段码、LED 与执行器提示', async () => {
    const model = harness({
      snapshot: snapshotOf({
        displays: { DS1: [0x3f, 0x06, 0x5b, 0x4f], DS2: [0, 0, 0, 0] },
        leds: [1, 0, 0, 0, 0, 0, 0, 0],
        relay: true,
        buzzer: true,
      }),
    });
    const { view } = mount(model.model);
    await view.initialize();
    const canvas = paint(view);

    expect(canvas.fills.some((style) => style.includes('255, 59, 48'))).toBe(true);
    expect(canvas.gradients).toHaveLength(1);
    expect(canvas.gradients[0]?.stops.some((stop) => stop.includes('255, 59, 48'))).toBe(true);
    expect(canvas.strokes.some((stroke) => stroke.style.includes('234, 183, 96'))).toBe(true);
  });

  it('跳线控件以局部不透明底座盖住照片，不再露出旧帽或金色桥线', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const initial = paint(view);
    const sockets = initial.rectangles.filter((rect) => rect.style === '#26312f');
    expect(sockets).toHaveLength(6);
    for (const layout of [J13, J5, J3, J2, J2_TX, J6]) {
      const point = center(layout.socket);
      expect(initial.rectangles.filter((rect) => contains(rect, point))).toHaveLength(1);
    }
    // J6 的位号和 OFF/ON 丝印不在遮盖矩形内。
    for (const point of [
      { x: 647, y: 429 },
      { x: 660, y: 440 },
      { x: 680, y: 440 },
    ]) {
      expect(initial.rectangles.filter((rect) => contains(rect, point))).toHaveLength(0);
    }
    for (const rect of sockets) {
      expect(rect.style).toMatch(/^#[\da-f]{6}$/i);
      expect(rect.width * rect.height).toBeLessThan(1500);
    }
    // 执行器未动作时，跳线不使用旧的金色桥线。
    expect(initial.strokes.some(({ style }) => style.includes('234, 183, 96'))).toBe(false);

    model.emit({ designator: 'J5', port: 'closedState', value: 0 });
    model.emit({ designator: 'J3', port: 'closedState', value: 0 });
    model.emit({ designator: 'J2', port: 'closedState2', value: 0 });
    model.emit({ designator: 'J6', port: 'closedState', value: 0 });
    const changed = paint(view);
    expect(changed.rectangles).toEqual(initial.rectangles);
  });

  it('电位器浮层留在板内，不覆盖旋钮、按键或跳线热区', () => {
    const controls = [...POTENTIOMETERS, ...KEYS, ...JUMPERS.map(({ hit }) => hit)];
    for (const layout of POTENTIOMETERS) {
      const { panel, track } = potentiometerSlider(layout);
      expect(track.width).toBeGreaterThanOrEqual(115);
      expect(panel.y).toBeGreaterThan(layout.y + layout.height);
      expect(contains(PHOTO_BOUNDS, panel)).toBe(true);
      expect(contains(PHOTO_BOUNDS, { x: panel.x + panel.width, y: panel.y + panel.height })).toBe(
        true,
      );
      expect(controls.some((control) => intersects(panel, control))).toBe(false);
    }
  });

  it('初始、悬停和展开均不覆盖实拍旋钮', async () => {
    const { view } = mount(harness().model);
    await view.initialize();
    const initial = paint(view);
    const point = { x: 757, y: 540 };
    await view.input({ ...pointer('pointermove', point), buttons: 0 });
    expect(paint(view)).toEqual(initial);
    expect(initial.texts).toEqual([]);

    await click(view, point);
    const open = paint(view);
    expect(open.texts).toEqual(['RB2', '0%']);
    for (const layout of POTENTIOMETERS) {
      expect(
        [...initial.rectangles, ...initial.rounded].some((rect) => intersects(rect, layout)),
      ).toBe(false);
      expect([...open.rectangles, ...open.rounded].some((rect) => intersects(rect, layout))).toBe(
        false,
      );
    }
  });

  it('灭灯不覆盖照片，低亮与全亮均覆盖发光面且保留等级差异', async () => {
    const model = harness({ snapshot: snapshotOf({ leds: [0, 0.1, 1, 0, 0, 0, 0, 0] }) });
    const { view } = mount(model.model);
    await view.initialize();
    const lit = paint(view);
    expect(lit.gradients).toHaveLength(2);
    const lenses = lit.ellipses.filter(({ radiusX, radiusY }) => radiusX >= 4 && radiusY >= 6);
    expect(lenses.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 358.5, y: 319 },
      { x: 378, y: 319 },
    ]);
    const opacity = (style: string) => Number.parseFloat(style.slice(style.lastIndexOf(',') + 1));
    const low = opacity(lenses[0]!.style);
    expect(low).toBeGreaterThan(0.4);
    expect(opacity(lenses[1]!.style)).toBeGreaterThan(low);

    model.emit({ designator: 'D2', port: 'brightness', value: 0 });
    model.emit({ designator: 'D3', port: 'brightness', value: 0 });
    const off = paint(view);
    expect(off.gradients).toHaveLength(0);
    expect(off.ellipses).toHaveLength(0);
  });

  it('事件通过 event.value 更新缓存并触发重绘，未知信号被忽略', async () => {
    const model = harness();
    const { view, invalidations } = mount(model.model);
    await view.initialize();
    const initial = invalidations();

    model.emit({ designator: 'DS1', port: 'digit1', value: 0x3f });
    model.emit({ designator: 'D1', port: 'brightness', value: 1 });
    model.emit({ designator: 'S1', port: 'pressed', value: 1 });
    expect(invalidations()).toBeGreaterThanOrEqual(initial + 3);

    const canvas = paint(view);
    expect(canvas.fills.some((style) => style.includes('255, 59, 48'))).toBe(true);
    expect(canvas.gradients).toHaveLength(1);
    expect(canvas.strokes.some((stroke) => stroke.style.includes('49, 210, 192'))).toBe(true);

    const beforeUnknown = invalidations();
    model.emit({ designator: 'U6', port: 'latch', value: 3 });
    expect(invalidations()).toBe(beforeUnknown);
  });

  it('初始查询不会覆盖查询开始后到达的较新事件', async () => {
    let resolveSnapshot!: (value: Value) => void;
    const model = harness({
      getSnapshot: () =>
        new Promise<Value>((resolve) => {
          resolveSnapshot = resolve;
        }),
    });
    const { view } = mount(model.model);
    const initialization = view.initialize();

    model.emit({ designator: 'DS1', port: 'digit1', value: 0x3f });
    model.emit({ designator: 'D1', port: 'brightness', value: 1 });
    resolveSnapshot(snapshotValue(snapshotOf({ relay: true })));
    await initialization;

    const canvas = paint(view);
    expect(canvas.fills.some((style) => style.includes('255, 59, 48'))).toBe(true);
    expect(canvas.gradients).toHaveLength(1);
    // 没有事件竞争的继电器字段仍应用初始快照。
    expect(canvas.strokes.some((stroke) => stroke.style.includes('234, 183, 96'))).toBe(true);
  });

  it('显示快照按 digit 粒度合并，不吞掉未竞争位的初值', () => {
    const store = createBoardStateStore();
    const base = store.beginSnapshot();
    store.applySignal({ designator: 'DS1', port: 'digit1', value: 9 });
    store.applySnapshot(snapshotOf({ displays: { DS1: [1, 2, 3, 4], DS2: [5, 6, 7, 8] } }), base);

    expect(store.state.displays.DS1).toEqual([9, 2, 3, 4]);
    expect(store.state.displays.DS2).toEqual([5, 6, 7, 8]);
  });

  it('同值事件也保护过期快照的 digit', () => {
    const store = createBoardStateStore();
    const base = store.beginSnapshot();
    // digit1 当前已经是 0；事件虽然不改变值，仍晚于快照查询开始。
    store.applySignal({ designator: 'DS1', port: 'digit1', value: 0 });
    store.applySnapshot(snapshotOf({ displays: { DS1: [5, 6, 7, 8], DS2: [1, 2, 3, 4] } }), base);

    expect(store.state.displays.DS1).toEqual([0, 6, 7, 8]);
    expect(store.state.displays.DS2).toEqual([1, 2, 3, 4]);
  });
});

describe('CT107D View2D 输入', () => {
  it('点击原图旋钮只展开或收起，一次只显示一个浮层', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();

    const rb2 = { x: 757, y: 540 };
    const rb4 = { x: 827, y: 540 };
    await view.input(pointer('pointerdown', rb2, 2));
    expect(paint(view).texts).toEqual([]);
    await view.input(pointer('pointerdown', rb2));
    const track = sliderPoint(sliderFor('RB2'), 1);
    await view.input(pointer('pointermove', track));
    await view.input(pointer('pointerup', track));
    expect(paint(view).texts).toEqual(['RB2', '0%']);
    await click(view, rb4);
    expect(paint(view).texts).toEqual(['RB4', '0%']);
    await click(view, rb4);
    expect(paint(view).texts).toEqual([]);
    await click(view, track);
    expect(model.potentiometerCalls).toEqual([]);
  });

  it('浮层标题和空白不写值，点板面其他控件时关闭并正常分派', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const rb2 = { x: 757, y: 540 };
    const { panel, track } = sliderFor('RB2');
    await click(view, rb2);
    await click(view, { x: panel.x + 20, y: panel.y + 16 });
    await click(view, { x: track.x + track.width + 3, y: center(track).y });
    expect(model.potentiometerCalls).toEqual([]);
    expect(paint(view).texts).toEqual(['RB2', '0%']);

    await click(view, { x: 510, y: 420 });
    expect(paint(view).texts).toEqual([]);
    await click(view, rb2);
    await click(view, keyCenter('S1'));
    expect(paint(view).texts).toEqual([]);
    expect(model.switchCalls).toEqual([
      { designator: 'S1', pressed: true },
      { designator: 'S1', pressed: false },
    ]);
    await click(view, rb2);
    await click(view, { x: 940, y: 468 });
    expect(paint(view).texts).toEqual([]);
    expect(model.jumperCalls).toEqual([{ designator: 'J3', closed: false }]);
    expect(model.potentiometerCalls).toEqual([]);
  });

  it('浮层轨道分别写入 RB2 的 AIN3、RB4 的滑臂和 RB3 的定时', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    await click(view, { x: 757, y: 540 });
    await click(view, sliderPoint(sliderFor('RB2'), 0.5));
    await click(view, { x: 827, y: 540 });
    await click(view, sliderPoint(sliderFor('RB4'), 0.25));
    await click(view, { x: 896, y: 540 });
    await click(view, sliderPoint(sliderFor('RB3'), 0.75));
    expect(model.potentiometerCalls).toEqual([
      ['setAnalogInput', { channel: 3, value: 0.5 }],
      ['setWiper', { value: 0.25 }],
      ['setFrequencyWiper', { value: 0.75 }],
    ]);
    expect(model.switchCalls).toEqual([]);
    expect(model.jumperCalls).toEqual([]);
  });

  it.each(['pointerup', 'pointercancel', 'pointerleave'] as const)(
    '拖动越界钳位，%s 结束手势但保留浮层',
    async (end) => {
      const model = harness();
      const { view } = mount(model.model);
      await view.initialize();
      await click(view, { x: 827, y: 540 });
      const slider = sliderFor('RB4');
      const handle = potentiometerSliderKnob(slider, 0);
      await view.input(pointer('pointerdown', { x: handle.x + 2, y: handle.y + 1 }));
      expect(model.potentiometerCalls).toEqual([]);
      await view.input(pointer('pointermove', sliderPoint(slider, 0.25)));
      await view.input(pointer('pointermove', { x: 1000, y: 700 }));
      await view.input(pointer('pointermove', { x: 1001, y: 700 }));
      await view.input(pointer('pointermove', { x: 0, y: 700 }));
      await view.input(pointer(end, { x: 900, y: 700 }));
      await view.input(pointer('pointermove', sliderPoint(slider, 0.8)));
      expect(model.potentiometerCalls).toEqual([
        ['setWiper', { value: 0.25 }],
        ['setWiper', { value: 1 }],
        ['setWiper', { value: 0 }],
      ]);
      expect(paint(view).texts).toEqual(['RB4', '0%']);
    },
  );

  it('滑块显示快照和模型事件，迟到的快照不覆盖新位置，点击不乐观改写', async () => {
    let resolveSnapshot!: (value: Value) => void;
    const model = harness({
      getSnapshot: () => new Promise((resolve) => (resolveSnapshot = resolve)),
    });
    const { view } = mount(model.model);
    const initialization = view.initialize();
    model.emit({ designator: 'RB2', port: 'position', value: 0.8 });
    resolveSnapshot(
      snapshotValue(snapshotOf({ potentiometers: { RB2: 0.25, RB3: 0.75, RB4: 0.5 } })),
    );
    await initialization;

    await click(view, { x: 827, y: 540 });
    expect(paint(view).texts).toEqual(['RB4', '50%']);
    await click(view, { x: 896, y: 540 });
    expect(paint(view).texts).toEqual(['RB3', '75%']);
    await click(view, { x: 757, y: 540 });
    const slider = sliderFor('RB2');
    await click(view, sliderPoint(slider, 0.2));
    const pending = paint(view);
    expect(pending.texts).toEqual(['RB2', '80%']);
    expect(filledRoundRect(pending, potentiometerSliderKnob(slider, 0.8))).toBeDefined();
    expect(model.potentiometerCalls).toEqual([['setAnalogInput', { channel: 3, value: 0.2 }]]);
    model.emit({ designator: 'RB2', port: 'position', value: 0.2 });
    const confirmed = paint(view);
    expect(confirmed.texts).toEqual(['RB2', '20%']);
    expect(filledRoundRect(confirmed, potentiometerSliderKnob(slider, 0.2))).toBeDefined();
  });

  it('17 个实拍键帽各自命中正确按键，并在键帽中心高亮', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    // 直接用 body.png 的测量点，避免布局和测试一起偏移。
    const centers = {
      S7: [145, 485],
      S6: [145, 535],
      S5: [145, 584],
      S4: [145, 633],
      S11: [204, 485],
      S10: [204, 535],
      S9: [204, 583],
      S8: [205, 633],
      S15: [263, 485],
      S14: [262, 534],
      S13: [262, 583],
      S12: [263, 632],
      S19: [321, 484],
      S18: [321, 534],
      S17: [321, 583],
      S16: [321, 632],
      S1: [378, 536],
    } satisfies Record<KeyDesignator, [number, number]>;
    for (const [designator, [x, y]] of Object.entries(centers)) {
      const point = { x, y };
      await view.input(pointer('pointerdown', point));
      expect(model.switchCalls.at(-1)).toEqual({ designator, pressed: true });
      const highlight = paint(view).strokes.filter(({ style }) => style.includes('49, 210, 192'));
      expect(highlight.map(({ points }) => points)).toEqual([[point]]);
      await view.input(pointer('pointerup', point));
      expect(model.switchCalls.at(-1)).toEqual({ designator, pressed: false });
    }
  });

  it('按下具体按键，移出热区或抬起时只释放该按键', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const s1 = keyCenter('S1');
    const s16 = keyCenter('S16');

    await view.input(pointer('pointerdown', s1));
    expect(model.switchCalls).toEqual([{ designator: 'S1', pressed: true }]);

    await view.input(pointer('pointermove', { x: 0, y: 0 }));
    expect(model.switchCalls.at(-1)).toEqual({ designator: 'S1', pressed: false });

    await view.input(pointer('pointerdown', s16));
    await view.input(pointer('pointerup', { x: 900, y: 700 }));
    expect(model.switchCalls.at(-1)).toEqual({ designator: 'S16', pressed: false });

    const calls = model.switchCalls.length;
    await view.input(pointer('pointerdown', { x: 100, y: 300 }));
    await view.input(pointer('pointerdown', s1, 2));
    expect(model.switchCalls).toHaveLength(calls);
  });

  it('pointercancel 也释放当前按键', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const point = keyCenter('S7');
    await view.input(pointer('pointerdown', point));
    await view.input(pointer('pointercancel', point));
    expect(model.switchCalls).toEqual([
      { designator: 'S7', pressed: true },
      { designator: 'S7', pressed: false },
    ]);
  });

  it('J13/J5 选择真实档位，J2 上下排各自可切换，J6 左右两档', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();

    await view.input(pointer('pointerdown', { x: 307, y: 373 }));
    await view.input(pointer('pointerdown', { x: 307, y: 409 }));
    expect(model.jumperCalls).toEqual([
      { designator: 'J13', closed: true },
      { designator: 'J13', closed: false },
    ]);

    await view.input(pointer('pointerdown', { x: 355, y: 672 }));
    await view.input(pointer('pointerdown', { x: 390, y: 672 }));
    expect(model.jumperCalls.slice(-2)).toEqual([
      { designator: 'J5', closed: false },
      { designator: 'J5', closed: true },
    ]);

    await view.input(pointer('pointerdown', { x: 583, y: 158 }));
    await view.input(pointer('pointerdown', { x: 605, y: 158 }));
    expect(model.jumperCalls.slice(-2)).toEqual([
      { designator: 'J2', closed: false },
      { designator: 'J2', closed: true },
    ]);

    await view.input(pointer('pointerdown', { x: 583, y: 181 }));
    await view.input(pointer('pointerdown', { x: 605, y: 181 }));
    expect(model.jumperCalls.slice(-2)).toEqual([
      { designator: 'J2', channel: 1, closed: false },
      { designator: 'J2', channel: 1, closed: true },
    ]);

    await view.input(pointer('pointerdown', { x: 940, y: 468 }));
    model.emit({ designator: 'J3', port: 'closedState', value: 0 });
    await view.input(pointer('pointerdown', { x: 940, y: 468 }));
    expect(model.jumperCalls.slice(-2)).toEqual([
      { designator: 'J3', closed: false },
      { designator: 'J3', closed: true },
    ]);

    await view.input(pointer('pointerdown', { x: 660, y: 430 }));
    await view.input(pointer('pointerdown', { x: 686, y: 430 }));
    expect(model.jumperCalls.slice(-2)).toEqual([
      { designator: 'J6', closed: false },
      { designator: 'J6', closed: true },
    ]);
  });

  it('J3、J2 上下排和 J6 根据独立状态绘制滑块', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const initial = paint(view);
    expect(filledRoundRect(initial, jumperKnobRect(J3, true))).toBeDefined();
    expect(filledRoundRect(initial, jumperKnobRect(J2, true))).toBeDefined();
    expect(filledRoundRect(initial, jumperKnobRect(J2_TX, false))).toBeDefined();
    expect(filledRoundRect(initial, jumperKnobRect(J6, true))).toBeDefined();
    expect(center(jumperKnobRect(J3, true)).y).toBeLessThan(center(jumperKnobRect(J3, false)).y);
    expect(center(jumperKnobRect(J2, false)).x).toBeLessThan(center(jumperKnobRect(J2, true)).x);
    expect(center(jumperKnobRect(J6, false)).x).toBeLessThan(center(jumperKnobRect(J6, true)).x);

    await view.input(pointer('pointerdown', { x: 605, y: 181 }));
    expect(filledRoundRect(paint(view), jumperKnobRect(J2_TX, true))).toBeUndefined();

    model.emit({ designator: 'J3', port: 'closedState', value: 0 });
    model.emit({ designator: 'J6', port: 'closedState', value: 0 });
    model.emit({ designator: 'J2', port: 'closedState1', value: 1 });
    const changed = paint(view);
    expect(filledRoundRect(changed, jumperKnobRect(J2_TX, true))).toBeDefined();
    expect(filledRoundRect(changed, jumperKnobRect(J2, true))).toBeDefined();
    expect(filledRoundRect(changed, jumperKnobRect(J3, false))).toBeDefined();
    expect(filledRoundRect(changed, jumperKnobRect(J6, false))).toBeDefined();
  });

  it('J6 滑块位置只由模型事件推进，点击本身不乐观改写状态', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();

    const initial = paint(view);
    expect(filledRoundRect(initial, jumperKnobRect(J6, true))).toBeDefined();
    expect(filledRoundRect(initial, jumperKnobRect(J6, false))).toBeUndefined();

    await view.input(pointer('pointerdown', { x: 660, y: 430 }));
    expect(model.jumperCalls.at(-1)).toEqual({ designator: 'J6', closed: false });
    const pending = paint(view);
    expect(filledRoundRect(pending, jumperKnobRect(J6, true))).toBeDefined();

    model.emit({ designator: 'J6', port: 'closedState', value: 0 });
    const off = paint(view);
    expect(filledRoundRect(off, jumperKnobRect(J6, false))).toBeDefined();
    expect(filledRoundRect(off, jumperKnobRect(J6, true))).toBeUndefined();
  });

  it('J13/J3 滑块位置只由模型事件推进，点击本身不乐观改写状态', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();

    await view.input(pointer('pointerdown', { x: 307, y: 409 }));
    expect(model.jumperCalls.at(-1)).toEqual({ designator: 'J13', closed: false });
    const pending = paint(view);
    expect(filledRoundRect(pending, jumperKnobRect(J13, true))).toBeDefined();
    expect(filledRoundRect(pending, jumperKnobRect(J13, false))).toBeUndefined();

    model.emit({ designator: 'J13', port: 'closedState', value: 0 });
    const changed = paint(view);
    expect(filledRoundRect(changed, jumperKnobRect(J13, false))).toBeDefined();

    await view.input(pointer('pointerdown', { x: 940, y: 468 }));
    expect(model.jumperCalls.at(-1)).toEqual({ designator: 'J3', closed: false });
    const j3Pending = paint(view);
    expect(filledRoundRect(j3Pending, jumperKnobRect(J3, true))).toBeDefined();
    model.emit({ designator: 'J3', port: 'closedState', value: 0 });
    expect(filledRoundRect(paint(view), jumperKnobRect(J3, false))).toBeDefined();
  });
});

describe('CT107D View2D 生命周期', () => {
  it('编辑态没有 model 时仍能绘制确定的初始状态', async () => {
    const { view } = mount(undefined);
    await view.initialize();
    const canvas = paint(view);
    expect(filledRoundRect(canvas, jumperKnobRect(J2, true))).toBeDefined();
    expect(filledRoundRect(canvas, jumperKnobRect(J2_TX, false))).toBeDefined();
    expect(
      canvas.rounded.some(({ operation, style }) => operation === 'fill' && style === '#151a19'),
    ).toBe(true);
    await view.input(pointer('pointerdown', keyCenter('S1')));
    await click(view, { x: 757, y: 540 });

    const afterPress = paint(view);
    expect(afterPress.texts).toEqual([]);
    expect(afterPress.fills).toEqual(canvas.fills);
    expect(afterPress.strokes.every((stroke) => !stroke.style.includes('49, 210, 192, 1'))).toBe(
      true,
    );
  });

  it('dispose 释放订阅并停止后续事件与输入', async () => {
    const model = harness();
    const { view, invalidations } = mount(model.model);
    await view.initialize();
    model.emit({ designator: 'D1', port: 'brightness', value: 1 });
    const beforeDispose = invalidations();
    expect(beforeDispose).toBeGreaterThan(0);

    view.dispose();
    expect(model.listenerCount()).toBe(0);
    expect(model.subscriptionDisposals()).toBe(1);

    model.emit({ designator: 'D2', port: 'brightness', value: 1 });
    expect(invalidations()).toBe(beforeDispose);

    await view.input(pointer('pointerdown', keyCenter('S1')));
    expect(model.switchCalls).toHaveLength(0);
    expect(paint(view).fills).toHaveLength(0);
  });

  it('dispose 时抬起正在按住的按键', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    await view.input(pointer('pointerdown', keyCenter('S1')));
    expect(model.switchCalls).toEqual([{ designator: 'S1', pressed: true }]);

    view.dispose();
    await Promise.resolve();
    expect(model.switchCalls.at(-1)).toEqual({ designator: 'S1', pressed: false });
  });

  it('模型方法拒绝会继续抛出，并清除按下反馈', async () => {
    const model = harness({ rejectSwitch: new Error('switch failed') });
    const { view } = mount(model.model);
    await view.initialize();
    const point = keyCenter('S1');
    await expect(Promise.resolve(view.input(pointer('pointerdown', point)))).rejects.toThrow(
      'switch failed',
    );
    expect(model.switchCalls).toHaveLength(1);

    await view.input(pointer('pointerup', point));
    expect(model.switchCalls).toHaveLength(1);
  });

  it('初始快照不完整时 initialize 明确失败', async () => {
    const model = harness({ getSnapshot: async () => ({ displays: {} }) });
    const { view } = mount(model.model);
    await expect(view.initialize()).rejects.toThrow(/snapshot/i);
  });
});

describe('CT107D View2D 声音', () => {
  it('只创建一个静音音调，仅 SP1 状态变化时调整音量', async () => {
    const model = harness();
    const { audio, createTone, set } = audioHarness();
    const { view } = mount(model.model, audio);
    await view.initialize();
    expect(createTone).toHaveBeenCalledExactlyOnceWith({
      frequency: 2000,
      type: 'square',
      volume: 0,
    });
    expect(set).not.toHaveBeenCalled();

    model.emit({ designator: 'SP1', port: 'active', value: 1 });
    model.emit({ designator: 'SP1', port: 'active', value: 1 });
    model.emit({ designator: 'K1', port: 'energized', value: 1 });
    model.emit({ designator: 'SP1', port: 'active', value: 0 });
    model.emit({ designator: 'SP1', port: 'active', value: 0 });
    expect(set.mock.calls).toEqual([
      [{ volume: 0.06 }, { rampMs: 5 }],
      [{ volume: 0 }, { rampMs: 5 }],
    ]);
  });

  it('快照中的蜂鸣器状态驱动音调', async () => {
    const model = harness({ snapshot: snapshotOf({ buzzer: true }) });
    const { audio, set } = audioHarness();
    const { view } = mount(model.model, audio);
    await view.initialize();
    expect(set).toHaveBeenCalledExactlyOnceWith({ volume: 0.06 }, { rampMs: 5 });
  });

  it('迟到的快照不会覆盖已激活的音调', async () => {
    let resolveSnapshot!: (value: Value) => void;
    const model = harness({
      getSnapshot: () =>
        new Promise<Value>((resolve) => {
          resolveSnapshot = resolve;
        }),
    });
    const { audio, set } = audioHarness();
    const { view } = mount(model.model, audio);
    const initialization = view.initialize();
    model.emit({ designator: 'SP1', port: 'active', value: 1 });
    resolveSnapshot(snapshotValue(snapshotOf({ buzzer: false })));
    await initialization;
    expect(set).toHaveBeenCalledExactlyOnceWith({ volume: 0.06 }, { rampMs: 5 });
  });

  it('dispose 释放订阅并停止音调一次', async () => {
    const model = harness();
    const { audio, set, stop } = audioHarness();
    const { view } = mount(model.model, audio);
    await view.initialize();
    model.emit({ designator: 'SP1', port: 'active', value: 1 });
    view.dispose();
    view.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(model.listenerCount()).toBe(0);
    model.emit({ designator: 'SP1', port: 'active', value: 0 });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('编辑态不申请音调句柄', async () => {
    const { audio, createTone } = audioHarness();
    const { view } = mount(undefined, audio);
    await view.initialize();
    expect(createTone).not.toHaveBeenCalled();
  });
});
