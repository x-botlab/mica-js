/**
 * widget 共用的绘制小工具。
 *
 * widget 运行在 guest worker 里，只有 `OffscreenCanvasRenderingContext2D`；这里不引入任何
 * 依赖，颜色只接受 `#RRGGBB` / `#RRGGBBAA`，与属性定义（color）保持一致。
 */

type Context = OffscreenCanvasRenderingContext2D;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** 把 `#RGB` / `#RRGGBB` / `#RRGGBBAA` 归一化；`alpha` 覆盖原有透明度。 */
export function color(value: unknown, fallback: string, alpha?: number): string {
  const text = typeof value === 'string' && HEX.test(value) ? value : fallback;
  const expand =
    text.length === 4
      ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
      : text.slice(0, 7);
  const red = Number.parseInt(expand.slice(1, 3), 16);
  const green = Number.parseInt(expand.slice(3, 5), 16);
  const blue = Number.parseInt(expand.slice(5, 7), 16);
  const own = text.length === 9 ? Number.parseInt(text.slice(7, 9), 16) / 255 : 1;
  const opacity = alpha === undefined ? own : Math.max(0, Math.min(1, alpha));

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export function label(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** 指针是否落在实例矩形内；没有坐标（键盘事件）时按落在内部处理。 */
export function inside(width: number, height: number, x?: number, y?: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  if (x !== undefined && (x < 0 || x >= width)) return false;
  if (y !== undefined && (y < 0 || y >= height)) return false;
  return true;
}

/** 清空并裁剪到实例矩形，返回 `false` 表示尺寸无效、这一帧直接跳过。 */
export function beginFrame(context: Context, width: number, height: number): boolean {
  if (!(Number.isFinite(width) && Number.isFinite(height)) || width <= 0 || height <= 0) {
    return false;
  }
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.clearRect(0, 0, width, height);
  return true;
}

export function centeredText(
  context: Context,
  value: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  maxWidth: number,
): void {
  if (maxWidth <= 0) return;
  context.font = `600 ${Math.max(9, size)}px ui-monospace, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = fill;
  context.fillText(value, x, y, maxWidth);
}
