import type { WidgetFactory } from '@mica-js/sdk/widget';
import { color, inside, label, panel, text } from '../drawing.js';

const create: WidgetFactory = (api) => {
  let pressed = false;
  api.publish('press', false);

  return {
    render(ctx) {
      const { width: w, height: h } = api;
      if (!panel(ctx, w, h)) return;
      const inset = Math.min(8, w * 0.1, h * 0.12);
      const bw = w - inset * 2;
      const bh = h - inset * 2;
      const depth = Math.min(4, bh * 0.12);
      ctx.fillStyle = '#0d1113';
      ctx.beginPath();
      ctx.roundRect(inset, inset, bw, bh, Math.min(6, bw / 2, bh / 2));
      ctx.fill();
      ctx.fillStyle = color(api.props.color, '#d78345');
      ctx.beginPath();
      ctx.roundRect(
        inset + 2,
        inset + (pressed ? depth : 0),
        Math.max(0, bw - 4),
        Math.max(0, bh - depth),
        Math.max(0, Math.min(4, (bw - 4) / 2, (bh - depth) / 2)),
      );
      ctx.fill();
      ctx.fillStyle = pressed ? '#00000033' : '#ffffff25';
      ctx.fill();
      text(
        ctx,
        label(api.props.label, '按钮'),
        w / 2,
        h / 2 + (pressed ? depth / 2 : -depth / 2),
        Math.min(15, h * 0.27),
        '#101416',
        bw - 10,
      );
      ctx.restore();
    },
    input(event) {
      if (
        event.type === 'pointerdown' &&
        (event.button === undefined || event.button === 0) &&
        inside(api, event)
      ) {
        if (pressed) return;
        pressed = true;
      } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
        if (!pressed) return;
        pressed = false;
      } else {
        return;
      }
      api.publish('press', pressed);
      api.invalidate();
    },
  };
};

export default create;
