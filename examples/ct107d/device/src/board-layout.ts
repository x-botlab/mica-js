/**
 * CT107D 板面几何：坐标全部取自 `build-canvas.mjs` 的实测照片像素，
 * 未在旧画布中使用的 J3/J5 由 `assets/ct107d-board.webp` 放大比对得到。
 *
 * View2D 的 flexible geometry 以 1068×768 为局部坐标；编辑器在缩放、旋转和自由
 * 尺寸变化时把指针反变换回同一坐标，因此绘制和命中测试共用这里的矩形。
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

export interface JumperLayout {
  readonly designator: JumperDesignator;
  readonly hit: Rect;
  readonly pins: readonly JumperPinLayout[];
  /** 固定短接，例如 J2 的 1-3。 */
  readonly fixed: readonly JumperPairLayout[];
  /** 可选择的桥接位置；J13/J5 为 1-2 与 2-3。 */
  readonly options: readonly JumperPairLayout[];
  /** true 表示点击切换通断；false 表示点击直接选择最近的位置。 */
  readonly toggle: boolean;
}

const KEY_SIZE = 40;

function key(designator: KeyDesignator, centerX: number, centerY: number): KeyLayout {
  return {
    designator,
    x: centerX - KEY_SIZE / 2,
    y: centerY - KEY_SIZE / 2,
    width: KEY_SIZE,
    height: KEY_SIZE,
  };
}

/** 键位中心点与 `build-canvas.mjs` 完全一致。 */
export const KEYS: readonly KeyLayout[] = [
  key('S7', 143, 491),
  key('S6', 143, 540),
  key('S5', 143, 588),
  key('S4', 143, 637),
  key('S11', 202, 491),
  key('S10', 202, 539),
  key('S9', 202, 588),
  key('S8', 203, 637),
  key('S15', 261, 491),
  key('S14', 261, 539),
  key('S13', 261, 588),
  key('S12', 261, 637),
  key('S19', 320, 491),
  key('S18', 320, 539),
  key('S17', 320, 588),
  key('S16', 320, 637),
  key('S1', 379, 540),
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
 * 4-6 为 VS1838（true）、2-4 为 CX20106A（false）。
 */
export const J13: JumperLayout = {
  designator: 'J13',
  hit: { x: 289, y: 370, width: 42, height: 72 },
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
};

export const J5: JumperLayout = {
  designator: 'J5',
  hit: { x: 350, y: 660, width: 44, height: 24 },
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
};

export const J3: JumperLayout = {
  designator: 'J3',
  hit: { x: 926, y: 454, width: 28, height: 30 },
  pins: [
    { pin: 1, x: 940, y: 464 },
    { pin: 2, x: 940, y: 473 },
  ],
  fixed: [],
  options: [{ closed: true, pins: [1, 2] }],
  toggle: true,
};

export const J2: JumperLayout = {
  designator: 'J2',
  hit: { x: 558, y: 136, width: 76, height: 64 },
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
};

export const JUMPERS: readonly JumperLayout[] = [J13, J5, J3, J2];

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
