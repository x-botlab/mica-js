import type { WidgetFactory } from '@mica-js/sdk/widget';
import { beginFrame, centeredText, color, inside, label, number } from '../drawing.js';

/**
 * 按键热区：一个半透明的圆角矩形，压在板面照片的轻触按键上。
 *
 * 未按下时只画出淡淡的定位框，按下时填充变亮并加粗描边，读数由 `press` 端口输出——
 * 画布把它绑到原理图里按键器件的 `press` 端口，闭合/断开就由仿真决定。
 *
 * 松开在 `pointerup` / `pointercancel` 时发生，指针移出实例也不影响：编辑器在按下时
 * 捕获指针，用户把指针拖出热区再松手同样会松开，和真实按钮的手感一致。
 */
const create: WidgetFactory = (api) => {
  let pressed = false;
  api.publish('press', false);

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (!beginFrame(context, width, height)) return;

      const accent = color(api.props.color, '#38bdf8ff');
      const radius = Math.min(number(api.props.radius, 10, 0, 64), width / 2, height / 2);
      const inset = Math.min(1.5, width / 8, height / 8);

      context.beginPath();
      context.roundRect(
        inset,
        inset,
        Math.max(0, width - inset * 2),
        Math.max(0, height - inset * 2),
        radius,
      );
      context.fillStyle = color(api.props.color, '#38bdf8ff', pressed ? 0.55 : 0.18);
      context.fill();
      context.lineWidth = pressed ? Math.max(2, Math.min(width, height) * 0.08) : 1;
      context.strokeStyle = color(api.props.color, '#38bdf8ff', pressed ? 1 : 0.6);
      context.stroke();

      if (pressed) {
        // 内圈高光，让按下的一瞬间在照片上看得见。
        const glow = Math.min(width, height) * 0.22;
        const gradient = context.createRadialGradient(
          width / 2,
          height / 2,
          0,
          width / 2,
          height / 2,
          Math.max(glow, 1),
        );
        gradient.addColorStop(0, color(api.props.color, '#38bdf8ff', 0.5));
        gradient.addColorStop(1, color(api.props.color, '#38bdf8ff', 0));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(width / 2, height / 2, Math.max(glow, 1), 0, Math.PI * 2);
        context.fill();
      }

      const caption = label(api.props.label, '');
      if (caption.length > 0) {
        centeredText(
          context,
          caption,
          width / 2,
          height / 2,
          Math.min(16, height * 0.4),
          pressed ? '#0b1220' : accent,
          width - 8,
        );
      }

      context.restore();
    },
    input(event) {
      if (event.type === 'pointerdown') {
        if (event.button !== undefined && event.button !== 0) return;
        if (!inside(api.width, api.height, event.x, event.y)) return;
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
