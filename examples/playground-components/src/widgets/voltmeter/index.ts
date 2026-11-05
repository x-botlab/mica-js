import type { WidgetFactory } from '@mica-js/sdk/widget';
import { color, label, panel, text } from '../drawing.js';

const create: WidgetFactory = (api) => {
  let voltage = 0;
  const unsubscribe = api.subscribe('voltage', (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === voltage) return;
    voltage = value;
    api.invalidate();
  });

  return {
    render(ctx) {
      const { width: w, height: h } = api;
      if (!panel(ctx, w, h)) return;
      const raw = api.props.precision;
      const precision =
        typeof raw === 'number' && Number.isFinite(raw)
          ? Math.max(0, Math.min(4, Math.trunc(raw)))
          : 2;
      const caption = label(api.props.label, '电压');
      const showLabel = caption.length > 0 && h >= 54 && w >= 40;
      const inset = Math.min(8, w * 0.08, h * 0.1);
      const top = showLabel ? Math.min(25, h * 0.3) : inset;
      ctx.fillStyle = '#0c1712';
      ctx.fillRect(inset, top, w - inset * 2, h - top - inset);
      if (showLabel) text(ctx, caption, w / 2, top / 2, 11, '#acb8b2', w - 12);
      // Keep extreme finite inputs readable without constructing an enormous fixed-point string.
      const reading =
        Math.abs(voltage) >= 1e7 ? voltage.toExponential(precision) : voltage.toFixed(precision);
      text(
        ctx,
        `${reading} V`,
        w / 2,
        (top + h - inset) / 2,
        Math.min(32, (h - top - inset) * 0.55),
        color(api.props.color, '#9fe3b5'),
        w - inset * 2 - 8,
        true,
      );
      ctx.restore();
    },
    dispose: unsubscribe,
  };
};

export default create;
