/**
 * CT107D 板面几何：坐标对应 View2D 使用的 `body.png` 照片像素。
 *
 * View2D 的 flexible geometry 以 1068×768 为局部坐标；编辑器在缩放、旋转和自由
 * 尺寸变化时把指针反变换回同一坐标，因此绘制和命中测试共用这里的坐标。
 */
import type { JumperDesignator, KeyDesignator } from './board-state.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect extends Point {
  readonly width: number;
  readonly height: number;
}

export const BOARD_BOUNDS: Rect = { x: 0, y: 0, width: 1068, height: 768 };

export interface KeyLayout extends Rect {
  readonly designator: KeyDesignator;
}

export interface DisplayLayout extends Rect {
  readonly designator: 'DS1' | 'DS2';
}

export interface LedLayout extends Point {
  readonly designator: string;
}

export interface ActuatorLayout extends Rect {
  readonly designator: 'SP1' | 'K1';
}

export interface JumperPinLayout extends Point {
  readonly pin: number;
}

export interface JumperPairLayout {
  /** 该桥接位置对应的模型布尔值；J3 只有闭合状态。 */
  readonly closed: boolean;
  readonly pins: readonly [number, number];
}

export interface JumperSliderLayout {
  /** 排针方向；竖向排针的滑块与握条旋转 90°。 */
  readonly orientation: 'horizontal' | 'vertical';
  /** 滑块行程所在的圆角轨道。 */
  readonly track: Rect;
  readonly knob: { readonly width: number; readonly height: number };
  /** false/OFF 端滑块中心。 */
  readonly off: Point;
  /** true/ON 端滑块中心。 */
  readonly on: Point;
}

export interface JumperLayout {
  readonly designator: JumperDesignator;
  readonly hit: Rect;
  /** 照片上接插件和静态跳线帽的范围，不包含周围丝印。 */
  readonly socket: Rect;
  readonly pins: readonly JumperPinLayout[];
  /** 固定短接，例如 J2 的 1-3。 */
  readonly fixed: readonly JumperPairLayout[];
  /** 可选择的桥接位置；J13/J5 为 1-2 与 2-3。 */
  readonly options: readonly JumperPairLayout[];
  /** true 表示点击切换通断；false 表示点击直接选择最近的位置。 */
  readonly toggle: boolean;
  readonly slider: JumperSliderLayout;
}

const KEY_HIT_SIZE = 36;

function key(designator: KeyDesignator, centerX: number, centerY: number): KeyLayout {
  return {
    designator,
    x: centerX - KEY_HIT_SIZE / 2,
    y: centerY - KEY_HIT_SIZE / 2,
    width: KEY_HIT_SIZE,
    height: KEY_HIT_SIZE,
  };
}

/** 逐个对齐照片里的黑色键帽中心，热区比键帽稍宽。 */
export const KEYS: readonly KeyLayout[] = [
  key('S7', 145, 485),
  key('S6', 145, 535),
  key('S5', 145, 584),
  key('S4', 145, 633),
  key('S11', 204, 485),
  key('S10', 204, 535),
  key('S9', 204, 583),
  key('S8', 205, 633),
  key('S15', 263, 485),
  key('S14', 262, 534),
  key('S13', 262, 583),
  key('S12', 263, 632),
  key('S19', 321, 484),
  key('S18', 321, 534),
  key('S17', 321, 583),
  key('S16', 321, 632),
  key('S1', 378, 536),
];

export const DISPLAYS: readonly DisplayLayout[] = [
  { designator: 'DS1', x: 502, y: 206, width: 126, height: 60 },
  { designator: 'DS2', x: 636, y: 206, width: 127, height: 60 },
];

/** D1–D8 的中心点；照片上丝印为 L1–L8。 */
export const LEDS: readonly LedLayout[] = [
  { designator: 'D1', x: 338.5, y: 319 },
  { designator: 'D2', x: 358.5, y: 319 },
  { designator: 'D3', x: 378, y: 319 },
  { designator: 'D4', x: 398, y: 319 },
  { designator: 'D5', x: 417.5, y: 319 },
  { designator: 'D6', x: 437, y: 319 },
  { designator: 'D7', x: 457, y: 319 },
  { designator: 'D8', x: 476.5, y: 319 },
];

export const BUZZER: ActuatorLayout = {
  designator: 'SP1',
  x: 688,
  y: 360,
  width: 60,
  height: 60,
};

export const RELAY: ActuatorLayout = {
  designator: 'K1',
  x: 762,
  y: 358,
  width: 88,
  height: 62,
};

/**
 * J13/J5 是真实的三脚选择器：中间脚为公共端，两个桥接位置分别是 1-2 与 2-3。
 * J3 是右侧扩展排针上 SIGNAL/P34 的两脚跳线；J2 是 2×3 排针，1-3 固定短接，
 * 4-6 为 VS1838（true）、2-4 为 CX20106A（false）。J6 是蜂鸣器下方的三针
 * 装配开关；网表与融合模型都没有它的电气连接，仅保存 OFF/ON 装配状态。
 */
export const J13: JumperLayout = {
  designator: 'J13',
  hit: { x: 289, y: 370, width: 42, height: 72 },
  socket: { x: 298, y: 374, width: 18, height: 40 },
  pins: [
    { pin: 1, x: 307, y: 403 },
    { pin: 2, x: 307, y: 391 },
    { pin: 3, x: 307, y: 379 },
  ],
  fixed: [],
  options: [
    { closed: false, pins: [1, 2] },
    { closed: true, pins: [2, 3] },
  ],
  toggle: false,
  slider: {
    orientation: 'vertical',
    track: { x: 302, y: 376, width: 10, height: 36 },
    knob: { width: 12, height: 10 },
    off: { x: 307, y: 397 },
    on: { x: 307, y: 385 },
  },
};

export const J5: JumperLayout = {
  designator: 'J5',
  hit: { x: 350, y: 660, width: 44, height: 24 },
  socket: { x: 352, y: 661, width: 42, height: 22 },
  pins: [
    { pin: 1, x: 357, y: 672 },
    { pin: 2, x: 371, y: 672 },
    { pin: 3, x: 385, y: 672 },
  ],
  fixed: [],
  options: [
    { closed: false, pins: [1, 2] },
    { closed: true, pins: [2, 3] },
  ],
  toggle: false,
  slider: {
    orientation: 'horizontal',
    track: { x: 354, y: 667, width: 38, height: 10 },
    knob: { width: 13, height: 11 },
    off: { x: 364, y: 672 },
    on: { x: 378, y: 672 },
  },
};

export const J3: JumperLayout = {
  designator: 'J3',
  hit: { x: 926, y: 454, width: 28, height: 30 },
  socket: { x: 933, y: 459, width: 14, height: 19 },
  pins: [
    { pin: 1, x: 940, y: 464 },
    { pin: 2, x: 940, y: 473 },
  ],
  fixed: [],
  options: [{ closed: true, pins: [1, 2] }],
  toggle: true,
  slider: {
    orientation: 'vertical',
    track: { x: 936, y: 461, width: 8, height: 16 },
    knob: { width: 10, height: 7 },
    off: { x: 940, y: 474 },
    on: { x: 940, y: 465 },
  },
};

export const J2: JumperLayout = {
  designator: 'J2',
  hit: { x: 558, y: 136, width: 76, height: 64 },
  socket: { x: 578, y: 154, width: 36, height: 32 },
  pins: [
    { pin: 1, x: 582, y: 181 },
    { pin: 2, x: 582, y: 158 },
    { pin: 3, x: 594, y: 181 },
    { pin: 4, x: 594, y: 158 },
    { pin: 5, x: 606, y: 181 },
    { pin: 6, x: 606, y: 158 },
  ],
  fixed: [{ closed: true, pins: [1, 3] }],
  options: [
    { closed: false, pins: [2, 4] },
    { closed: true, pins: [4, 6] },
  ],
  toggle: false,
  slider: {
    orientation: 'horizontal',
    track: { x: 579, y: 154, width: 34, height: 10 },
    knob: { width: 12, height: 10 },
    off: { x: 588, y: 159 },
    on: { x: 600, y: 159 },
  },
};

export const J6: JumperLayout = {
  designator: 'J6',
  hit: { x: 646, y: 418, width: 54, height: 32 },
  // 只盖住黑色三针本体，保留上方 SP1、左侧 J6 和下方 OFF/ON 丝印。
  socket: { x: 652, y: 422, width: 43, height: 16 },
  pins: [
    { pin: 1, x: 661, y: 430 },
    { pin: 2, x: 672, y: 430 },
    { pin: 3, x: 683, y: 430 },
  ],
  fixed: [],
  options: [
    { closed: false, pins: [1, 2] },
    { closed: true, pins: [2, 3] },
  ],
  toggle: false,
  slider: {
    orientation: 'horizontal',
    track: { x: 654, y: 425, width: 39, height: 9 },
    knob: { width: 14, height: 10 },
    off: { x: 662, y: 429.5 },
    on: { x: 684, y: 429.5 },
  },
};

export const JUMPERS: readonly JumperLayout[] = [J13, J5, J3, J2, J6];

export interface JumperChoice {
  readonly designator: JumperDesignator;
  /** 未给出时表示切换 J3 的通断。 */
  readonly closed?: boolean;
}

export function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

export function keyAt(point: Point): KeyLayout | undefined {
  return KEYS.find((layout) => contains(layout, point));
}

export function keyLayout(designator: KeyDesignator): KeyLayout {
  const layout = KEYS.find((entry) => entry.designator === designator);
  if (layout === undefined) throw new Error(`Unknown CT107D key: ${designator}`);
  return layout;
}

export function jumperAt(point: Point): JumperLayout | undefined {
  return JUMPERS.find((layout) => contains(layout.hit, point));
}

export function pinPosition(layout: JumperLayout, pin: number): Point {
  const found = layout.pins.find((entry) => entry.pin === pin);
  if (found === undefined) throw new Error(`${layout.designator} has no pin ${pin}`);
  return { x: found.x, y: found.y };
}

function pairCenter(layout: JumperLayout, pair: JumperPairLayout): Point {
  const first = pinPosition(layout, pair.pins[0]);
  const second = pinPosition(layout, pair.pins[1]);
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

/** 滑块矩形；绘制和档位回归共用同一几何。 */
export function jumperKnobRect(layout: JumperLayout, closed: boolean): Rect {
  const { knob, off, on } = layout.slider;
  const center = closed ? on : off;
  return {
    x: center.x - knob.width / 2,
    y: center.y - knob.height / 2,
    width: knob.width,
    height: knob.height,
  };
}

function nearestOption(layout: JumperLayout, point: Point): JumperPairLayout | undefined {
  let best: JumperPairLayout | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of layout.options) {
    const center = pairCenter(layout, option);
    const distance = Math.hypot(center.x - point.x, center.y - point.y);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 把一次点击转换成模型选择。
 *
 * - J13/J5 选择离点击最近的 1-2 或 2-3，而不是把三脚选择器当成两脚开关；
 * - J2 只有上方第二路可切换，点击固定的 1-3 一侧不产生操作；
 * - J3 返回不带 `closed` 的选择，由调用者按当前状态切换通断。
 */
export function jumperChoiceAt(point: Point): JumperChoice | undefined {
  const layout = jumperAt(point);
  if (layout === undefined) return undefined;
  if (layout.toggle) return { designator: layout.designator };
  if (layout.designator === 'J2' && point.y > layout.hit.y + layout.hit.height / 2) {
    return undefined;
  }
  const option = nearestOption(layout, point);
  return option === undefined
    ? undefined
    : { designator: layout.designator, closed: option.closed };
}
