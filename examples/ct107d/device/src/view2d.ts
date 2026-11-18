/**
 * CT107D 整板 View2D：照片由 `geometry.bodyImage` 承载，这里只画不遮挡丝印的本地叠层。
 *
 * - 红色：DS1/DS2 段码与 D1–D8 亮度；
 * - 青绿：按键按下/悬停与跳线悬停；
 * - 金色：SP1/K1 执行器提示与真实跳线帽位置。
 *
 * 所有可见状态都来自模型事件或 `getSnapshot(null)`；指针状态只用于按下瞬间的反馈。
 * 模型方法失败时返回的 Promise 会继续拒绝，交给展示宿主的诊断通道，不在视图里吞掉。
 */
import type { Value } from '@mica-js/document/fused';
import type {
  FusedView2DFactory,
  IFusedView2D,
  IFusedView2DContext,
  IFusedViewInput,
} from '@mica-js/editor/fused/runtime';
import {
  BUZZER,
  DISPLAYS,
  JUMPERS,
  KEYS,
  LEDS,
  RELAY,
  jumperAt,
  jumperChoiceAt,
  keyAt,
  keyLayout,
  pinPosition,
  type JumperLayout,
  type JumperPairLayout,
  type Point,
  type Rect,
} from './board-layout.js';
import {
  createBoardStateStore,
  readBoardSignal,
  readBoardSnapshot,
  type BoardState,
  type JumperDesignator,
  type KeyDesignator,
} from './board-state.js';

/** 宿主合同只声明三种指针事件；取消/移出按新版宿主的归一化约定也按抬起处理。 */
export type BoardViewEvent =
  | IFusedViewInput
  | (Omit<IFusedViewInput, 'type'> & {
      readonly type: 'pointercancel' | 'pointerleave';
    });

/** 正式入口只依赖 View2D 上下文中的模型代理与重绘回调。 */
export type BoardViewDependencies = Pick<IFusedView2DContext, 'model' | 'invalidate'>;

/** View2D 工厂返回的对象，收紧为总是实现四个钩子。 */
export interface BoardView extends IFusedView2D {
  initialize(): Promise<void>;
  renderOverlay(context: OffscreenCanvasRenderingContext2D): void;
  input(event: BoardViewEvent): void | Promise<void>;
  dispose(): void;
}

interface Interaction {
  hoveredKey: KeyDesignator | undefined;
  hoveredJumper: JumperDesignator | undefined;
  /** 当前按住的具体按键；抬起、移出或取消时释放它。 */
  pointerKey: KeyDesignator | undefined;
}

const RED_ON = 'rgba(255, 59, 48, 0.94)';
const RED_OFF = 'rgba(124, 32, 27, 0.24)';
const TEAL = 'rgba(49, 210, 192, 1)';
const TEAL_SOFT = 'rgba(49, 210, 192, 0.55)';
const GOLD = 'rgba(234, 183, 96, 0.96)';
const GOLD_DIM = 'rgba(234, 183, 96, 0.2)';

const DIGIT_ASPECT = 0.58;

export function createBoardView(context: BoardViewDependencies): BoardView {
  const store = createBoardStateStore();
  const interaction: Interaction = {
    hoveredKey: undefined,
    hoveredJumper: undefined,
    pointerKey: undefined,
  };
  let disposed = false;
  let activated = false;

  const subscribe = context.model?.events['onDidSignal'];
  const subscription =
    subscribe === undefined
      ? undefined
      : subscribe((event) => {
          if (disposed) return;
          const signal = readBoardSignal(event.value);
          if (signal === undefined || !store.applySignal(signal)) return;
          invalidate();
        });

  function invalidate(): void {
    if (disposed) return;
    context.invalidate();
  }

  function callModel(name: string, params: Value): Promise<Value> {
    const model = context.model;
    if (model === undefined) return Promise.resolve(null);
    const method = model.methods[name];
    if (method === undefined) {
      throw new Error(`CT107D model method "${name}" is not declared.`);
    }
    return method(params);
  }

  function clearPointerKey(designator: KeyDesignator): void {
    if (interaction.pointerKey !== designator) return;
    interaction.pointerKey = undefined;
    invalidate();
  }

  function refreshHover(point: Point): void {
    const key = keyAt(point)?.designator;
    const jumper = key === undefined ? jumperAt(point)?.designator : undefined;
    if (interaction.hoveredKey === key && interaction.hoveredJumper === jumper) return;
    interaction.hoveredKey = key;
    interaction.hoveredJumper = jumper;
    invalidate();
  }

  function releasePointerKey(): Promise<void> | undefined {
    const designator = interaction.pointerKey;
    if (designator === undefined) return undefined;
    interaction.pointerKey = undefined;
    invalidate();
    if (context.model === undefined) return undefined;
    return callModel('setSwitch', { designator, pressed: false }).then(() => undefined);
  }

  function pressPointerKey(designator: KeyDesignator): Promise<void> | undefined {
    // 编辑态和没有模型的器件没有权威按键状态，只保留悬停反馈，不制造“已按下”的假象。
    if (context.model === undefined) return undefined;
    interaction.pointerKey = designator;
    interaction.hoveredKey = designator;
    interaction.hoveredJumper = undefined;
    invalidate();

    let pending: Promise<Value>;
    try {
      pending = callModel('setSwitch', { designator, pressed: true });
    } catch (cause) {
      clearPointerKey(designator);
      throw cause;
    }
    return pending.then(
      () => undefined,
      (cause: unknown) => {
        clearPointerKey(designator);
        throw cause;
      },
    );
  }

  function pointerDown(event: IFusedViewInput): Promise<void> | undefined {
    if (event.button !== 0) return undefined;
    refreshHover(event.position);
    if (interaction.pointerKey !== undefined) return undefined;

    const choice = jumperChoiceAt(event.position);
    if (choice !== undefined) {
      const closed = choice.closed ?? !store.state.jumpers[choice.designator];
      return callModel('setJumper', { designator: choice.designator, closed }).then(
        () => undefined,
      );
    }

    const key = keyAt(event.position);
    if (key === undefined) return undefined;
    return pressPointerKey(key.designator);
  }

  function pointerMove(event: IFusedViewInput): void | Promise<void> {
    refreshHover(event.position);
    const pressed = interaction.pointerKey;
    if (pressed === undefined) return undefined;
    if (contains(keyLayout(pressed), event.position)) return undefined;
    // 宿主捕获指针后仍会继续发送 move；拖出按键即按抬起处理，避免按键卡在按下状态。
    return releasePointerKey();
  }

  function pointerUp(event: IFusedViewInput): void | Promise<void> {
    refreshHover(event.position);
    return releasePointerKey();
  }

  function reportDisposeReleaseFailure(designator: KeyDesignator, cause: unknown): void {
    console.error(`CT107D View2D: releasing ${designator} during dispose failed.`, cause);
  }

  function releaseHeldKeyOnDispose(designator: KeyDesignator): void {
    const model = context.model;
    if (model === undefined) return;
    const method = model.methods['setSwitch'];
    if (method === undefined) return;
    try {
      void method({ designator, pressed: false }).catch((cause: unknown) => {
        reportDisposeReleaseFailure(designator, cause);
      });
    } catch (cause) {
      reportDisposeReleaseFailure(designator, cause);
    }
  }

  return {
    async initialize() {
      if (disposed || activated) return;
      activated = true;
      if (context.model === undefined) {
        invalidate();
        return;
      }

      const baseRevision = store.beginSnapshot();
      let raw: Value;
      try {
        raw = await callModel('getSnapshot', null);
      } catch (cause) {
        if (disposed) return;
        throw cause;
      }
      if (disposed) return;
      const snapshot = readBoardSnapshot(raw);
      store.applySnapshot(snapshot, baseRevision);
      invalidate();
    },

    renderOverlay(canvas) {
      if (disposed) return;
      drawBoard(canvas, store.state, interaction);
    },

    input(event) {
      if (disposed) return undefined;
      switch (event.type) {
        case 'pointerdown':
          return pointerDown(event);
        case 'pointermove':
          return pointerMove(event);
        case 'pointerup':
          return pointerUp(event);
        case 'pointercancel':
        case 'pointerleave':
          interaction.hoveredKey = undefined;
          interaction.hoveredJumper = undefined;
          invalidate();
          return releasePointerKey();
        default:
          return undefined;
      }
    },

    dispose() {
      if (disposed) return;
      const held = interaction.pointerKey;
      disposed = true;
      subscription?.dispose();
      interaction.pointerKey = undefined;
      interaction.hoveredKey = undefined;
      interaction.hoveredJumper = undefined;
      // 宿主先释放展示、再释放模型；把按住的键显式抬起，避免模型侧留下按下状态。
      if (held !== undefined) releaseHeldKeyOnDispose(held);
    },
  };
}

/** 正式 `view2d.entry` 工厂；`FusedView2DFactory` 检查上下文与返回值合同。 */
export const createView: FusedView2DFactory = (context) => createBoardView(context);

export default createView;

/** 绘制整板叠层；导出给单测，不读取任何全局或宿主状态。 */
export function drawBoard(
  canvas: OffscreenCanvasRenderingContext2D,
  state: BoardState,
  interaction: Interaction,
): void {
  canvas.save();
  try {
    for (const display of DISPLAYS)
      drawDisplay(canvas, display, state.displays[display.designator]);
    drawLeds(canvas, state);
    drawActuators(canvas, state);
    for (const jumper of JUMPERS) {
      drawJumper(canvas, jumper, state.jumpers[jumper.designator], interaction);
    }
    drawKeys(canvas, state, interaction);
  } finally {
    canvas.restore();
  }
}

function drawKeys(
  canvas: OffscreenCanvasRenderingContext2D,
  state: BoardState,
  interaction: Interaction,
): void {
  for (const layout of KEYS) {
    const active =
      state.switches[layout.designator] || interaction.pointerKey === layout.designator;
    const hovered = interaction.hoveredKey === layout.designator;
    if (!active && !hovered) continue;

    const rect = insetRect(layout, 2);
    canvas.beginPath();
    canvas.roundRect(rect.x, rect.y, rect.width, rect.height, 8);
    if (active) {
      canvas.fillStyle = 'rgba(49, 210, 192, 0.18)';
      canvas.fill();
    }
    canvas.strokeStyle = active ? TEAL : TEAL_SOFT;
    canvas.lineWidth = active ? 1.8 : 1.1;
    canvas.stroke();
  }
}

function drawDisplay(
  canvas: OffscreenCanvasRenderingContext2D,
  display: Rect,
  digits: readonly number[],
): void {
  const cellWidth = display.width / 4;
  const available = cellWidth * 0.78;
  const digitHeight = Math.min(display.height * 0.82, available / DIGIT_ASPECT);
  const digitWidth = digitHeight * DIGIT_ASPECT;
  const thickness = Math.max(1.4, digitHeight * 0.13);
  const pointSize = Math.max(1.8, digitHeight * 0.09);
  const top = display.y + (display.height - digitHeight) / 2;

  for (let index = 0; index < 4; index += 1) {
    const left = display.x + index * cellWidth + (cellWidth - digitWidth) / 2;
    drawDigit(
      canvas,
      { left, top, width: digitWidth, height: digitHeight },
      thickness,
      digits[index] ?? 0,
      pointSize,
    );
  }
}

interface Cell {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function drawDigit(
  canvas: OffscreenCanvasRenderingContext2D,
  cell: Cell,
  thickness: number,
  mask: number,
  pointSize: number,
): void {
  const { left, top, width, height } = cell;
  const half = thickness / 2;
  const gap = thickness * 0.22;
  const right = left + width;
  const bottom = top + height;
  const middle = top + height / 2;
  const innerLeft = left + half + gap;
  const innerRight = right - half - gap;

  const bars: readonly {
    readonly bit: number;
    readonly axis: 'x' | 'y';
    readonly from: number;
    readonly to: number;
    readonly at: number;
  }[] = [
    { bit: 0, axis: 'x', from: innerLeft, to: innerRight, at: top + half },
    { bit: 6, axis: 'x', from: innerLeft, to: innerRight, at: middle },
    { bit: 3, axis: 'x', from: innerLeft, to: innerRight, at: bottom - half },
    { bit: 5, axis: 'y', from: top + half + gap, to: middle - gap, at: left + half },
    { bit: 1, axis: 'y', from: top + half + gap, to: middle - gap, at: right - half },
    { bit: 4, axis: 'y', from: middle + gap, to: bottom - half - gap, at: left + half },
    { bit: 2, axis: 'y', from: middle + gap, to: bottom - half - gap, at: right - half },
  ];

  for (const bar of bars) {
    if (!(bar.to > bar.from)) continue;
    canvas.fillStyle = (mask & (1 << bar.bit)) === 0 ? RED_OFF : RED_ON;
    if (bar.axis === 'x') horizontalBar(canvas, bar.from, bar.to, bar.at, thickness);
    else verticalBar(canvas, bar.at, bar.from, bar.to, thickness);
    canvas.fill();
  }

  canvas.fillStyle = (mask & 0x80) === 0 ? RED_OFF : RED_ON;
  canvas.beginPath();
  canvas.roundRect(right - pointSize, bottom - pointSize, pointSize, pointSize, pointSize * 0.25);
  canvas.fill();
}

function horizontalBar(
  canvas: OffscreenCanvasRenderingContext2D,
  left: number,
  right: number,
  center: number,
  thickness: number,
): void {
  const half = thickness / 2;
  canvas.beginPath();
  canvas.moveTo(left, center);
  canvas.lineTo(left + half, center - half);
  canvas.lineTo(right - half, center - half);
  canvas.lineTo(right, center);
  canvas.lineTo(right - half, center + half);
  canvas.lineTo(left + half, center + half);
  canvas.closePath();
}

function verticalBar(
  canvas: OffscreenCanvasRenderingContext2D,
  center: number,
  top: number,
  bottom: number,
  thickness: number,
): void {
  const half = thickness / 2;
  canvas.beginPath();
  canvas.moveTo(center, top);
  canvas.lineTo(center + half, top + half);
  canvas.lineTo(center + half, bottom - half);
  canvas.lineTo(center, bottom);
  canvas.lineTo(center - half, bottom - half);
  canvas.lineTo(center - half, top + half);
  canvas.closePath();
}

function drawLeds(canvas: OffscreenCanvasRenderingContext2D, state: BoardState): void {
  for (let index = 0; index < LEDS.length; index += 1) {
    const level = state.leds[index] ?? 0;
    if (level <= 0) continue;
    const led = LEDS[index]!;
    const halo = 7 + level * 7;
    const gradient = canvas.createRadialGradient(led.x, led.y, 0, led.x, led.y, halo);
    gradient.addColorStop(0, `rgba(255, 82, 68, ${0.42 + level * 0.42})`);
    gradient.addColorStop(0.45, `rgba(255, 59, 48, ${0.16 + level * 0.22})`);
    gradient.addColorStop(1, 'rgba(255, 59, 48, 0)');
    canvas.fillStyle = gradient;
    canvas.beginPath();
    canvas.arc(led.x, led.y, halo, 0, Math.PI * 2);
    canvas.fill();

    canvas.fillStyle = `rgba(255, 196, 184, ${0.35 + level * 0.55})`;
    canvas.beginPath();
    canvas.ellipse(led.x, led.y, 2.1, 3.6 + level * 1.8, 0, 0, Math.PI * 2);
    canvas.fill();
  }
}

function drawActuators(canvas: OffscreenCanvasRenderingContext2D, state: BoardState): void {
  if (state.buzzer) {
    const cx = BUZZER.x + BUZZER.width / 2;
    const cy = BUZZER.y + BUZZER.height / 2;
    canvas.strokeStyle = GOLD;
    canvas.lineWidth = 1.8;
    canvas.beginPath();
    canvas.arc(cx, cy, 23, 0, Math.PI * 2);
    canvas.stroke();
    canvas.lineWidth = 1.4;
    for (const radius of [30, 37]) {
      canvas.beginPath();
      canvas.arc(cx, cy, radius, -0.55, 0.55);
      canvas.stroke();
    }
  }

  if (state.relay) {
    const rect = insetRect(RELAY, 4);
    canvas.beginPath();
    canvas.roundRect(rect.x, rect.y, rect.width, rect.height, 6);
    canvas.strokeStyle = GOLD;
    canvas.lineWidth = 1.8;
    canvas.stroke();
    canvas.fillStyle = GOLD;
    canvas.beginPath();
    canvas.arc(rect.x + rect.width - 7, rect.y + 7, 2.3, 0, Math.PI * 2);
    canvas.fill();
  }
}

function drawJumper(
  canvas: OffscreenCanvasRenderingContext2D,
  layout: JumperLayout,
  closed: boolean,
  interaction: Interaction,
): void {
  for (const pin of layout.pins) {
    canvas.fillStyle = 'rgba(234, 183, 96, 0.82)';
    canvas.beginPath();
    canvas.arc(pin.x, pin.y, 2.2, 0, Math.PI * 2);
    canvas.fill();
  }

  const selected = layout.options.find((option) => option.closed === closed);
  for (const pair of layout.fixed) drawBridge(canvas, layout, pair, true);
  if (selected !== undefined) drawBridge(canvas, layout, selected, true);
  for (const option of layout.options) {
    if (option === selected) continue;
    drawBridge(canvas, layout, option, false);
  }

  if (interaction.hoveredJumper === layout.designator) {
    const rect = insetRect(layout.hit, 1);
    canvas.beginPath();
    canvas.roundRect(rect.x, rect.y, rect.width, rect.height, 6);
    canvas.strokeStyle = TEAL_SOFT;
    canvas.lineWidth = 1.2;
    canvas.stroke();
  }
}

function drawBridge(
  canvas: OffscreenCanvasRenderingContext2D,
  layout: JumperLayout,
  pair: JumperPairLayout,
  active: boolean,
): void {
  const first = pinPosition(layout, pair.pins[0]);
  const second = pinPosition(layout, pair.pins[1]);
  canvas.lineCap = 'round';
  if (active) {
    canvas.strokeStyle = 'rgba(36, 27, 12, 0.62)';
    canvas.lineWidth = 6.4;
    bridgePath(canvas, first, second);
    canvas.stroke();
    canvas.strokeStyle = GOLD;
    canvas.lineWidth = 3.8;
    bridgePath(canvas, first, second);
    canvas.stroke();
  } else {
    canvas.strokeStyle = GOLD_DIM;
    canvas.lineWidth = 1.3;
    bridgePath(canvas, first, second);
    canvas.stroke();
  }
}

function bridgePath(canvas: OffscreenCanvasRenderingContext2D, first: Point, second: Point): void {
  canvas.beginPath();
  canvas.moveTo(first.x, first.y);
  canvas.lineTo(second.x, second.y);
}

function insetRect(rect: Rect, inset: number): Rect {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2),
  };
}

function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}
