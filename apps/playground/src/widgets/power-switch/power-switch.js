export default function powerSwitch(api) {
  let on = api.props.on !== false;
  const label = () => (typeof api.props.label === 'string' ? api.props.label : '电源');
  const onColor = () => (typeof api.props.onColor === 'string' ? api.props.onColor : '#22C55E');
  const offColor = () => (typeof api.props.offColor === 'string' ? api.props.offColor : '#3F3F46');

  function publish() {
    api.publish('power', on, 0);
  }

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;
      context.clearRect(0, 0, width, height);

      const pad = Math.max(8, Math.min(width, height) * 0.1);
      const trackWidth = Math.max(28, Math.min(height * 0.62, width * 0.34));
      const trackHeight = Math.max(16, height - pad * 2);
      const left = width - pad - trackWidth;
      const top = pad;

      // Switch track
      context.fillStyle = on ? onColor() : offColor();
      rounded(context, left, top, trackWidth, trackHeight, trackHeight / 2);
      context.fill();

      // Thumb
      const thumb = trackHeight * 0.44;
      const thumbX = on ? left + trackWidth - thumb - 3 : left + thumb + 3;
      context.beginPath();
      context.arc(thumbX, top + trackHeight / 2, thumb, 0, Math.PI * 2);
      context.fillStyle = '#FAFAFA';
      context.fill();

      // Status lamp
      const lampX = pad + thumb;
      const lampY = top + trackHeight / 2;
      context.beginPath();
      context.arc(lampX, lampY, thumb * 0.62, 0, Math.PI * 2);
      context.fillStyle = on ? onColor() : 'rgba(113, 113, 122, 0.5)';
      context.fill();
      if (on) {
        context.beginPath();
        context.arc(lampX, lampY, thumb * 1.05, 0, Math.PI * 2);
        context.fillStyle = hexWithAlpha(onColor(), 0.22);
        context.fill();
      }

      // Text
      const textLeft = lampX + thumb * 1.7;
      const room = Math.max(0, left - textLeft - pad * 0.5);
      if (room < 12) return;
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillStyle = '#F4F4F5';
      let size = Math.max(9, Math.min(height * 0.3, room * 0.5));
      context.font = `600 ${size}px system-ui, sans-serif`;
      const title = label();
      if (context.measureText(title).width > room) {
        size = Math.max(7, (size * room) / context.measureText(title).width);
        context.font = `600 ${size}px system-ui, sans-serif`;
      }
      context.fillText(title, textLeft, lampY);
    },

    input(event) {
      if (event.type !== 'pointerdown') return;
      on = !on;
      api.invalidate();
      publish();
    },

    /**
     * Follows the inspector.
     *
     * `on` is the authoritative state of the part: changing it through the
     * property panel is the same action as clicking the switch, so the widget
     * re-renders *and* publishes. Colour changes only repaint.
     */
    onPropsChanged(props) {
      const next = props.on !== false;
      const changed = next !== on;
      on = next;
      api.invalidate();
      if (changed) publish();
    },
  };
}

function rounded(context, x, y, width, height, radius) {
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
}

/** `#RRGGBB` plus an alpha byte, for the lamp halo. */
function hexWithAlpha(value, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match === null) return 'rgba(34, 197, 94, 0.22)';
  const byte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${match[1]}${byte}`;
}
