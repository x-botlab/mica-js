import type { WidgetInstanceApi, WidgetInputEvent } from '@mica-js/sdk/widget';

type Context = OffscreenCanvasRenderingContext2D;

export function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function label(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function panel(ctx: Context, width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#202427';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#495156';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
  return true;
}

export function text(
  ctx: Context,
  value: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  maxWidth: number,
  mono = false,
): void {
  if (maxWidth <= 0) return;
  ctx.font = `600 ${Math.max(11, size)}px ${mono ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fill;
  ctx.fillText(value, x, y, maxWidth);
}

export function inside(api: WidgetInstanceApi, event: WidgetInputEvent): boolean {
  return (
    (event.x === undefined || (event.x >= 0 && event.x < api.width)) &&
    (event.y === undefined || (event.y >= 0 && event.y < api.height)) &&
    api.width > 0 &&
    api.height > 0
  );
}
