import type { WidgetFactory } from '@mica-js/sdk/widget';
import { beginFrame, centeredText, color, label } from '../drawing.js';

/**
 * 继电器状态叠层：跟着 `energized` 画出线圈与触点位置，吸合时给出暖色底和高亮。
 */
const create: WidgetFactory = (api) => {
  let energized = false;
  const unsubscribe = api.subscribe('energized', (value) => {
    if (typeof value !== 'boolean' || value === energized) return;
    energized = value;
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (!beginFrame(context, width, height)) return;

      const inset = Math.min(width, height) * 0.08;
      const left = inset;
      const top = inset;
      const boxWidth = Math.max(1, width - inset * 2);
      const boxHeight = Math.max(1, height - inset * 2);

      context.fillStyle = color(api.props.color, '#f59e0bff', energized ? 0.32 : 0.08);
      context.beginPath();
      context.roundRect(left, top, boxWidth, boxHeight, Math.min(8, inset * 2));
      context.fill();
      context.strokeStyle = color(api.props.color, '#f59e0bff', energized ? 1 : 0.5);
      context.lineWidth = energized ? 2 : 1;
      context.stroke();

      const coilWidth = boxWidth * 0.28;
      const coilHeight = boxHeight * 0.42;
      const coilLeft = left + boxWidth * 0.12;
      const coilTop = top + (boxHeight - coilHeight) / 2;
      context.fillStyle = color(api.props.color, '#f59e0bff', energized ? 0.88 : 0.24);
      context.beginPath();
      context.roundRect(coilLeft, coilTop, coilWidth, coilHeight, Math.min(4, coilHeight / 4));
      context.fill();

      const contactLeft = left + boxWidth * 0.5;
      const contactRight = left + boxWidth * 0.82;
      const pivotY = top + boxHeight * 0.68;
      const openY = top + boxHeight * 0.3;
      const closedY = top + boxHeight * 0.48;
      const leverY = energized ? closedY : openY;
      context.strokeStyle = color(api.props.color, '#f59e0bff', 0.92);
      context.lineWidth = Math.max(1.5, Math.min(width, height) * 0.035);
      context.beginPath();
      context.moveTo(contactLeft, pivotY);
      context.lineTo(contactRight, leverY);
      context.stroke();
      for (const [x, y] of [
        [contactLeft, pivotY],
        [contactRight, leverY],
      ] as const) {
        context.fillStyle = color(api.props.color, '#f59e0bff', 0.92);
        context.beginPath();
        context.arc(x, y, Math.max(2, Math.min(width, height) * 0.04), 0, Math.PI * 2);
        context.fill();
      }

      const caption = label(api.props.label, 'K1');
      centeredText(
        context,
        `${caption} ${energized ? 'ON' : 'OFF'}`,
        width / 2,
        top + boxHeight * 0.88,
        Math.min(12, boxHeight * 0.16),
        color(api.props.color, '#f59e0bff', energized ? 1 : 0.72),
        width - 8,
      );
      context.restore();
    },
    dispose: unsubscribe,
  };
};

export default create;
