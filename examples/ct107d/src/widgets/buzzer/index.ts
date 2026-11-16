import type { WidgetFactory } from '@mica-js/sdk/widget';
import { beginFrame, centeredText, color, label, number } from '../drawing.js';

/**
 * 有源蜂鸣器状态叠层：SP1 发声时在板面照片上叠加暖色光晕和两道声波。
 *
 * `active` 来自 buzzer 器件的同名端口。未发声时不遮挡照片，只绘制可选标签。
 */
const create: WidgetFactory = (api) => {
  let active = false;
  const unsubscribe = api.subscribe('active', (value) => {
    if (typeof value !== 'boolean' || value === active) return;
    active = value;
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (!beginFrame(context, width, height)) return;

      const caption = label(api.props.label, 'SP1');
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.34;

      if (active) {
        const spread = radius * (1.4 + number(api.props.glow, 1.2, 0.2, 3));
        const glow = context.createRadialGradient(cx, cy, radius * 0.15, cx, cy, spread);
        glow.addColorStop(0, color(api.props.color, '#f59e0bff', 0.72));
        glow.addColorStop(0.48, color(api.props.color, '#f59e0bff', 0.3));
        glow.addColorStop(1, color(api.props.color, '#f59e0bff', 0));
        context.fillStyle = glow;
        context.beginPath();
        context.arc(cx, cy, spread, 0, Math.PI * 2);
        context.fill();

        context.strokeStyle = color(api.props.color, '#f59e0bff', 0.9);
        context.lineWidth = Math.max(1.5, Math.min(width, height) * 0.035);
        for (const scale of [1.25, 1.65]) {
          context.beginPath();
          context.arc(cx, cy, radius * scale, -Math.PI * 0.28, Math.PI * 0.28);
          context.stroke();
          context.beginPath();
          context.arc(cx, cy, radius * scale, Math.PI * 0.72, Math.PI * 1.28);
          context.stroke();
        }

        context.fillStyle = color(api.props.color, '#f59e0bff', 0.8);
        context.beginPath();
        context.arc(cx, cy, radius * 0.7, 0, Math.PI * 2);
        context.fill();
      }

      if (caption.length > 0) {
        centeredText(
          context,
          active ? `${caption} ON` : caption,
          cx,
          height - Math.max(8, height * 0.13),
          Math.min(13, height * 0.2),
          color(api.props.color, '#f59e0bff', active ? 1 : 0.72),
          width - 4,
        );
      }

      context.restore();
    },
    dispose: unsubscribe,
  };
};

export default create;
