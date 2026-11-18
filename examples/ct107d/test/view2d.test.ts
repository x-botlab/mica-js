import { describe, expect, it } from 'vitest';
import { timePs } from '@mica-js/core';
import type { Event } from '@mica-js/core/lifecycle';
import type { Value } from '@mica-js/document/fused';
import type { IFusedModelClient } from '@mica-js/editor/fused/runtime';
import type { ModelEvent } from '@mica-js/sdk/fused';
import { createBoardView, type BoardView, type BoardViewEvent } from '../device/src/view2d.js';
import { J13, J2, J3, J5, keyLayout } from '../device/src/board-layout.js';
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
}

function snapshotOf(options: SnapshotOptions = {}): BoardSnapshot {
  const switches = Object.fromEntries(
    KEY_DESIGNATORS.map((designator) => [designator, false]),
  ) as Record<KeyDesignator, boolean>;
  for (const designator of options.pressed ?? []) switches[designator] = true;
  const jumpers = Object.fromEntries(
    JUMPER_DESIGNATORS.map((designator) => [designator, true]),
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
  };
}

interface ModelHarness {
  readonly model: IFusedModelClient;
  readonly switchCalls: SwitchCall[];
  readonly jumperCalls: JumperCall[];
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
        if (typeof designator !== 'string' || typeof closed !== 'boolean') {
          throw new TypeError('setJumper expects { designator, closed }.');
        }
        jumperCalls.push({ designator, closed });
        if (options.rejectJumper !== undefined) throw options.rejectJumper;
        return null;
      },
      async getSnapshot() {
        return options.getSnapshot === undefined
          ? snapshotValue(snapshot)
          : await options.getSnapshot();
      },
    },
    events: { onDidSignal },
  };

  return {
    model,
    switchCalls,
    jumperCalls,
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
  fillRectCalls = 0;
  private points: PaintPoint[] = [];

  save(): void {}
  restore(): void {}
  beginPath(): void {
    this.points = [];
  }
  closePath(): void {}
  moveTo(x: number, y: number): void {
    this.points = [{ x, y }];
  }
  lineTo(x: number, y: number): void {
    this.points.push({ x, y });
  }
  arc(): void {}
  ellipse(): void {}
  roundRect(): void {}
  fill(): void {
    this.fills.push(String(this.fillStyle));
  }
  stroke(): void {
    this.strokes.push({ style: String(this.strokeStyle), points: [...this.points] });
  }
  fillRect(): void {
    this.fillRectCalls += 1;
  }
  createRadialGradient(): CanvasGradient {
    const gradient = new FakeGradient();
    this.gradients.push(gradient);
    return gradient as unknown as CanvasGradient;
  }
}

function mount(model?: IFusedModelClient) {
  let invalidations = 0;
  const view = createBoardView({
    model,
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
  return { type, position, button, buttons: type === 'pointerup' ? 0 : 1 };
}

function activeVerticalSegment(
  canvas: FakeCanvas,
  x: number,
): { from: number; to: number } | undefined {
  for (const stroke of canvas.strokes) {
    if (!stroke.style.includes('234, 183, 96, 0.96')) continue;
    const first = stroke.points[0];
    const second = stroke.points[1];
    if (first === undefined || second === undefined || stroke.points.length !== 2) continue;
    if (first.x !== x || second.x !== x) continue;
    return { from: Math.min(first.y, second.y), to: Math.max(first.y, second.y) };
  }
  return undefined;
}

describe('CT107D View2D 绘制', () => {
  it('绘制段码、LED 与执行器提示，不铺满整板的覆盖卡片', async () => {
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
    expect(canvas.fillRectCalls).toBe(0);
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
  it('按下具体按键，移出热区或抬起时只释放该按键', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const s1 = keyLayout('S1');
    const s16 = keyLayout('S16');

    await view.input(pointer('pointerdown', { x: s1.x + 20, y: s1.y + 20 }));
    expect(model.switchCalls).toEqual([{ designator: 'S1', pressed: true }]);

    await view.input(pointer('pointermove', { x: 0, y: 0 }));
    expect(model.switchCalls.at(-1)).toEqual({ designator: 'S1', pressed: false });

    await view.input(pointer('pointerdown', { x: s16.x + 20, y: s16.y + 20 }));
    await view.input(pointer('pointerup', { x: 900, y: 700 }));
    expect(model.switchCalls.at(-1)).toEqual({ designator: 'S16', pressed: false });

    const calls = model.switchCalls.length;
    await view.input(pointer('pointerdown', { x: 100, y: 300 }));
    await view.input(pointer('pointerdown', { x: s1.x + 20, y: s1.y + 20 }, 2));
    expect(model.switchCalls).toHaveLength(calls);
  });

  it('pointercancel 也释放当前按键', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const s7 = keyLayout('S7');

    await view.input(pointer('pointerdown', { x: s7.x + 20, y: s7.y + 20 }));
    await view.input(pointer('pointercancel', { x: s7.x + 20, y: s7.y + 20 }));
    expect(model.switchCalls).toEqual([
      { designator: 'S7', pressed: true },
      { designator: 'S7', pressed: false },
    ]);
  });

  it('J13/J5 选择真实的 1-2 或 2-3，J2 固定 1-3 不可切换', async () => {
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

    const beforeFixed = model.jumperCalls.length;
    await view.input(pointer('pointerdown', { x: 594, y: 181 }));
    expect(model.jumperCalls).toHaveLength(beforeFixed);

    await view.input(pointer('pointerdown', { x: 940, y: 468 }));
    model.emit({ designator: 'J3', port: 'closedState', value: 0 });
    await view.input(pointer('pointerdown', { x: 940, y: 468 }));
    expect(model.jumperCalls.slice(-2)).toEqual([
      { designator: 'J3', closed: false },
      { designator: 'J3', closed: true },
    ]);
  });

  it('跳线位置只由模型事件推进，点击本身不乐观改写状态', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();

    const initial = activeVerticalSegment(paint(view), J13.pins[1]!.x);
    expect(initial).toEqual({ from: 379, to: 391 });

    await view.input(pointer('pointerdown', { x: 307, y: 409 }));
    expect(model.jumperCalls.at(-1)).toEqual({ designator: 'J13', closed: false });
    expect(activeVerticalSegment(paint(view), J13.pins[1]!.x)).toEqual({ from: 379, to: 391 });

    model.emit({ designator: 'J13', port: 'closedState', value: 0 });
    expect(activeVerticalSegment(paint(view), J13.pins[1]!.x)).toEqual({ from: 391, to: 403 });
  });
});

describe('CT107D View2D 生命周期', () => {
  it('编辑态没有 model 时仍能绘制确定的初始状态', async () => {
    const { view } = mount(undefined);
    await view.initialize();
    const canvas = paint(view);
    expect(canvas.fillRectCalls).toBe(0);
    expect(canvas.strokes.some((stroke) => stroke.style.includes('234, 183, 96'))).toBe(true);
    await view.input(pointer('pointerdown', { x: 379, y: 540 }));

    const afterPress = paint(view);
    expect(afterPress.fills.some((style) => style.includes('49, 210, 192'))).toBe(false);
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

    await view.input(pointer('pointerdown', { x: 379, y: 540 }));
    expect(model.switchCalls).toHaveLength(0);
    expect(paint(view).fills).toHaveLength(0);
  });

  it('dispose 时抬起正在按住的按键', async () => {
    const model = harness();
    const { view } = mount(model.model);
    await view.initialize();
    const s1 = keyLayout('S1');

    await view.input(pointer('pointerdown', { x: s1.x + 20, y: s1.y + 20 }));
    expect(model.switchCalls).toEqual([{ designator: 'S1', pressed: true }]);

    view.dispose();
    await Promise.resolve();
    expect(model.switchCalls.at(-1)).toEqual({ designator: 'S1', pressed: false });
  });

  it('模型方法拒绝会继续抛出，并清除按下反馈', async () => {
    const model = harness({ rejectSwitch: new Error('switch failed') });
    const { view } = mount(model.model);
    await view.initialize();
    const s1 = keyLayout('S1');

    await expect(
      Promise.resolve(view.input(pointer('pointerdown', { x: s1.x + 20, y: s1.y + 20 }))),
    ).rejects.toThrow('switch failed');
    expect(model.switchCalls).toHaveLength(1);

    await view.input(pointer('pointerup', { x: s1.x + 20, y: s1.y + 20 }));
    expect(model.switchCalls).toHaveLength(1);
  });

  it('初始快照不完整时 initialize 明确失败', async () => {
    const model = harness({ getSnapshot: async () => ({ displays: {} }) });
    const { view } = mount(model.model);
    await expect(view.initialize()).rejects.toThrow(/snapshot/i);
  });
});
