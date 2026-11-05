import type { WidgetFactory } from '@mica-js/sdk/widget';
import { color, label, panel, text } from '../drawing.js';

const create: WidgetFactory = (api) => {
  let brightness = 0;
  const unsubscribe = api.subscribe('brightness', (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(1, value));
    if (next === brightness) return;
    brightness = next;
    api.invalidate();
  });

  return {
    render(ctx) {
      const { width: w, height: h } = api;
      if (!panel(ctx, w, h)) return;
      const caption = label(api.props.label, '指示灯');
      const showLabel = caption.length > 0 && h >= 52 && w >= 36;
      const cx = w / 2;
      const cy = showLabel ? h * 0.4 : h / 2;
      const r = Math.min(w * 0.28, h * (showLabel ? 0.24 : 0.34), 24);
      const on = color(api.props.color, '#45c692');
      ctx.beginPath();
      ctx.arc(cx, cy, r + Math.min(3, r * 0.2), 0, Math.PI * 2);
      ctx.fillStyle = '#0c1012';
      ctx.fill();
      ctx.strokeStyle = '#647078';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color(api.props.offColor, '#26332e');
      ctx.fill();
      if (brightness > 0) {
        ctx.save();
        ctx.globalAlpha = brightness;
        ctx.fillStyle = on;
        ctx.shadowColor = on;
        ctx.shadowBlur = r * 0.6 * brightness;
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(cx - r * 0.25, cy - r * 0.3, r * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.12 + brightness * 0.42})`;
      ctx.fill();
      if (showLabel) text(ctx, caption, cx, h * 0.82, 12, '#d7dfe2', w - 12);
      ctx.restore();
    },
    dispose: unsubscribe,
  };
};

export default create;
