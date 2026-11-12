import type { WidgetFactory } from '@mica-js/sdk/widget';
import { beginFrame, color, number } from '../drawing.js';

/**
 * LED 发光叠层：压在板面照片的 LED 上，只画光晕，不画底板。
 *
 * `brightness`（0–1）来自 `blue-led` 器件的同名端口，等于正向电流与额定电流之比。
 * 亮度为 0 时不画任何东西，照片里的 LED 本体保持原样；亮度越大，光晕越亮、扩散越远。
 */
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
    render(context) {
      const width = api.width;
      const height = api.height;
      if (!beginFrame(context, width, height)) return;
      if (brightness <= 0) {
        context.restore();
        return;
      }

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.5;
      // 光晕半径随亮度增长：亮度 0.16 的小电流也能看出光点，满亮时铺满实例。
      const spread = radius * (1 + number(api.props.glow, 1, 0, 3) * (0.4 + brightness * 1.2));
      const glow = context.createRadialGradient(cx, cy, radius * 0.2, cx, cy, spread);
      glow.addColorStop(0, color(api.props.color, '#3b82f6ff', 0.35 + brightness * 0.55));
      glow.addColorStop(0.45, color(api.props.color, '#3b82f6ff', 0.18 + brightness * 0.3));
      glow.addColorStop(1, color(api.props.color, '#3b82f6ff', 0));

      context.fillStyle = glow;
      context.beginPath();
      context.arc(cx, cy, spread, 0, Math.PI * 2);
      context.fill();

      context.beginPath();
      context.ellipse(cx, cy, radius * 0.72, radius, 0, 0, Math.PI * 2);
      context.fillStyle = color(api.props.color, '#3b82f6ff', 0.25 + brightness * 0.7);
      context.fill();

      context.restore();
    },
    dispose: unsubscribe,
  };
};

export default create;
