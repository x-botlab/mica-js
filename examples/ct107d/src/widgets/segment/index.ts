import type { WidgetFactory } from '@mica-js/sdk/widget';
import { beginFrame, color, number } from '../drawing.js';

/**
 * 四位共阴七段数码管。
 *
 * 四个输入端口各接一份 8 位段码：`bit0 = a`、`bit1 = b`、…、`bit6 = g`、`bit7 = dp`，
 * 与 `seg4` 器件输出的 `digit1`–`digit4` 一致。模型不做亮度积分，端口给什么就画什么，
 * 所以遮罩在板面照片上时看到的就是仿真里最近一次扫描锁存的内容。
 */

/** 一位数字的宽高比：真实 0.56 吋数码管明显高于宽。 */
const DIGIT_ASPECT = 0.58;
/** 字高最多占实例高度的比例。 */
const HEIGHT_FILL = 0.86;
const DIGITS = 4;

interface Cell {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 横笔画：两端切成 45°，和真实数码管一致。 */
function horizontalBar(
  context: OffscreenCanvasRenderingContext2D,
  left: number,
  right: number,
  center: number,
  thickness: number,
): void {
  const half = thickness / 2;
  context.beginPath();
  context.moveTo(left, center);
  context.lineTo(left + half, center - half);
  context.lineTo(right - half, center - half);
  context.lineTo(right, center);
  context.lineTo(right - half, center + half);
  context.lineTo(left + half, center + half);
  context.closePath();
}

/** 竖笔画：同样的斜角，沿竖直方向。 */
function verticalBar(
  context: OffscreenCanvasRenderingContext2D,
  center: number,
  top: number,
  bottom: number,
  thickness: number,
): void {
  const half = thickness / 2;
  context.beginPath();
  context.moveTo(center, top);
  context.lineTo(center + half, top + half);
  context.lineTo(center + half, bottom - half);
  context.lineTo(center, bottom);
  context.lineTo(center - half, bottom - half);
  context.lineTo(center - half, top + half);
  context.closePath();
}

function drawDigit(
  context: OffscreenCanvasRenderingContext2D,
  cell: Cell,
  thickness: number,
  mask: number,
  on: string,
  off: string,
  pointSize: number,
): void {
  const { left, top, width, height } = cell;
  const half = thickness / 2;
  // 间隙随笔画缩放：笔画越粗，段与段之间的缝也越大。
  const gap = thickness * 0.22;
  const right = left + width;
  const bottom = top + height;
  const middle = top + height / 2;
  const innerLeft = left + half + gap;
  const innerRight = right - half - gap;

  const bars = [
    { bit: 0, axis: 'x', from: innerLeft, to: innerRight, at: top + half },
    { bit: 6, axis: 'x', from: innerLeft, to: innerRight, at: middle },
    { bit: 3, axis: 'x', from: innerLeft, to: innerRight, at: bottom - half },
    { bit: 5, axis: 'y', from: top + half + gap, to: middle - gap, at: left + half },
    { bit: 1, axis: 'y', from: top + half + gap, to: middle - gap, at: right - half },
    { bit: 4, axis: 'y', from: middle + gap, to: bottom - half - gap, at: left + half },
    { bit: 2, axis: 'y', from: middle + gap, to: bottom - half - gap, at: right - half },
  ] as const;

  for (const bar of bars) {
    if (!(bar.to > bar.from)) continue;
    context.fillStyle = (mask & (1 << bar.bit)) === 0 ? off : on;
    if (bar.axis === 'x') horizontalBar(context, bar.from, bar.to, bar.at, thickness);
    else verticalBar(context, bar.at, bar.from, bar.to, thickness);
    context.fill();
  }

  if (pointSize > 0) {
    const size = Math.max(height * pointSize, 1);
    context.fillStyle = (mask & 0x80) === 0 ? off : on;
    context.beginPath();
    context.roundRect(left + width - size, bottom - size, size, size, Math.min(size / 2, 2));
    context.fill();
  }
}

const create: WidgetFactory = (api) => {
  const masks = [0, 0, 0, 0];
  const unsubscribe = [0, 1, 2, 3].map((index) =>
    api.subscribe(`digit${index + 1}`, (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const next = Math.max(0, Math.min(255, Math.trunc(value)));
      if (next === masks[index]) return;
      masks[index] = next;
      api.invalidate();
    }),
  );

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (!beginFrame(context, width, height)) return;

      context.fillStyle = color(api.props.background, '#0b0d0eff');
      context.beginPath();
      context.roundRect(0, 0, width, height, Math.min(3, width / 8, height / 8));
      context.fill();

      const on = color(api.props.color, '#ff3b30ff');
      const off = color(api.props.offColor, '#1f242766');
      const spacing = number(api.props.spacing, 0.08, 0, 0.5);
      const pointSize = number(api.props.pointSize, 0.1, 0, 0.3);

      const cellWidth = width / DIGITS;
      const inset = (cellWidth * spacing) / 2;
      const available = Math.max(1, cellWidth - inset * 2);
      // 小数点占位先扣掉，剩下的宽度才留给七段。
      const point = Math.max(height * pointSize, 0);
      const pointGap = point > 0 ? point * 0.4 : 0;
      const heightFromWidth = (available - point - pointGap) / DIGIT_ASPECT;
      const digitHeight = Math.max(1, Math.min(height * HEIGHT_FILL, heightFromWidth));
      const digitWidth = digitHeight * DIGIT_ASPECT;
      const thickness = Math.max(1, digitHeight * number(api.props.thickness, 0.12, 0.04, 0.3));
      const top = (height - digitHeight) / 2;

      for (let index = 0; index < DIGITS; index += 1) {
        const totalWidth = digitWidth + point + pointGap;
        const left = index * cellWidth + (cellWidth - totalWidth) / 2;
        drawDigit(
          context,
          { left, top, width: digitWidth, height: digitHeight },
          thickness,
          masks[index]!,
          on,
          off,
          pointSize,
        );
      }

      context.restore();
    },
    dispose() {
      for (const stop of unsubscribe) stop();
    },
  };
};

export default create;
