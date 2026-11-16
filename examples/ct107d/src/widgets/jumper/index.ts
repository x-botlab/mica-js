import type { WidgetFactory } from '@mica-js/sdk/widget';
import { beginFrame, centeredText, color, inside, label, number } from '../drawing.js';

/**
 * 通用交互式跳线：支持单路或两路布局。
 *
 * 每个通道都有 `stateN` 输入和 `closedN` 输出，可分别绑定独立 jumper 通道。单路实例用于
 * J13；两路实例用于 `jumper-2x3` 的 J2。两路布局可用 `fixed1` 把第一路显示为固定短接，
 * 只让第二路响应点击。
 */
const create: WidgetFactory = (api) => {
  const channels = number(api.props.channels, 1, 1, 2) >= 2 ? 2 : 1;
  const fixed1 = channels === 2 && api.props.fixed1 === true;
  const closed = [api.props.closed1 !== false, api.props.closed2 !== false];
  let hovered = -1;

  const unsubscribers = Array.from({ length: channels }, (_, index) =>
    api.subscribe(`state${index + 1}`, (value) => {
      if (typeof value !== 'boolean' || value === closed[index]) return;
      closed[index] = value;
      api.invalidate();
    }),
  );

  const channelAt = (x?: number, y?: number): number => {
    if (!inside(api.width, api.height, x, y)) return -1;
    if (channels === 1 || y === undefined) return 0;
    return y < api.height / 2 ? 0 : 1;
  };

  const toggle = (index: number) => {
    if (index < 0 || (index === 0 && fixed1)) return;
    closed[index] = !closed[index];
    api.publish(`closed${index + 1}`, closed[index]);
    api.invalidate();
  };

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (!beginFrame(context, width, height)) return;

      const inset = Math.min(width, height) * 0.07;
      const left = inset;
      const top = inset;
      const boxWidth = Math.max(1, width - inset * 2);
      const boxHeight = Math.max(1, height - inset * 2);
      const rowHeight = boxHeight / channels;
      const padRadius = Math.max(2, Math.min(width / 5, rowHeight * 0.18));
      const labels = [
        label(api.props.label1, channels === 2 ? '1' : label(api.props.label, 'J13')),
        label(api.props.label2, '2'),
      ];

      context.fillStyle = color(api.props.color, '#22c55eff', hovered >= 0 ? 0.2 : 0.1);
      context.beginPath();
      context.roundRect(left, top, boxWidth, boxHeight, Math.min(8, inset * 2));
      context.fill();
      context.strokeStyle = color(api.props.color, '#22c55eff', 0.72);
      context.lineWidth = 1;
      context.stroke();

      for (let index = 0; index < channels; index += 1) {
        const rowTop = top + rowHeight * index;
        const cy = rowTop + rowHeight * 0.52;
        const padA = left + boxWidth * 0.27;
        const padB = left + boxWidth * 0.73;
        const interactive = index === 0 ? !fixed1 : true;
        const active = hovered === index && interactive;

        if (closed[index]) {
          context.strokeStyle = color(api.props.color, '#22c55eff', active ? 1 : 0.92);
          context.lineWidth = Math.max(3, Math.min(width, height) * 0.055);
          context.beginPath();
          context.moveTo(padA, cy);
          context.lineTo(padB, cy);
          context.stroke();
        } else {
          context.strokeStyle = color(api.props.color, '#22c55eff', 0.35);
          context.lineWidth = Math.max(1, Math.min(width, height) * 0.025);
          context.beginPath();
          context.moveTo(padA + padRadius, cy);
          context.lineTo(padB - padRadius, cy);
          context.stroke();
        }

        for (const x of [padA, padB]) {
          context.fillStyle = color(
            api.props.color,
            '#22c55eff',
            interactive ? (closed[index] ? 1 : 0.7) : 0.5,
          );
          context.beginPath();
          context.arc(x, cy, padRadius, 0, Math.PI * 2);
          context.fill();
        }

        if (channels === 2) {
          centeredText(
            context,
            `${labels[index]} ${closed[index] ? 'CLOSED' : 'OPEN'}`,
            width / 2,
            rowTop + rowHeight * 0.16,
            Math.min(8, rowHeight * 0.22),
            color(api.props.color, '#22c55eff', closed[index] ? 0.92 : 0.6),
            width - 6,
          );
        }
      }

      if (channels === 1) {
        const caption = label(api.props.label, 'J13');
        centeredText(
          context,
          `${caption} ${closed[0] ? 'CLOSED' : 'OPEN'}`,
          width / 2,
          top + boxHeight * 0.88,
          Math.min(11, boxHeight * 0.14),
          color(api.props.color, '#22c55eff', closed[0] ? 1 : 0.7),
          width - 6,
        );
      }
      context.restore();
    },
    input(event) {
      if (event.type === 'pointermove') {
        const next = channelAt(event.x, event.y);
        if (next !== hovered) {
          hovered = next;
          api.invalidate();
        }
        return;
      }
      if (event.type === 'pointerleave') {
        if (hovered < 0) return;
        hovered = -1;
        api.invalidate();
        return;
      }
      if (event.type !== 'pointerdown') return;
      if (event.button !== undefined && event.button !== 0) return;
      toggle(channelAt(event.x, event.y));
    },
    dispose() {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
};

export default create;
