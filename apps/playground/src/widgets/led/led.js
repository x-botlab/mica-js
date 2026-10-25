export default function led(api) {
  let on = api.props.on === true;

  const onColor = () => (typeof api.props.onColor === 'string' ? api.props.onColor : '#EF4444');
  const offColor = () => (typeof api.props.offColor === 'string' ? api.props.offColor : '#3F3F46');
  const label = () => (typeof api.props.label === 'string' ? api.props.label : 'LED');

  // The simulation side owns `on`: every publish from the bound endpoint lands here.
  api.subscribe('on', (payload) => {
    const next = payload === true;
    if (next === on) return;
    on = next;
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;
      context.clearRect(0, 0, width, height);

      const labelHeight = Math.max(10, Math.min(height * 0.18, 18));
      const radius = Math.max(4, Math.min((width - 16) / 2, (height - labelHeight - 16) / 2));
      const cx = width / 2;
      const cy = (height - labelHeight) / 2 + 2;

      if (on) {
        context.beginPath();
        context.arc(cx, cy, radius * 1.45, 0, Math.PI * 2);
        context.fillStyle = hexWithAlpha(onColor(), 0.18);
        context.fill();
      }

      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.fillStyle = on ? onColor() : offColor();
      context.fill();
      context.lineWidth = Math.max(1, radius * 0.12);
      context.strokeStyle = on ? hexWithAlpha(onColor(), 0.9) : 'rgba(161, 161, 170, 0.45)';
      context.stroke();

      // A highlight sells the glass dome without a second gradient pass.
      context.beginPath();
      context.arc(cx - radius * 0.28, cy - radius * 0.32, radius * 0.22, 0, Math.PI * 2);
      context.fillStyle = on ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.16)';
      context.fill();

      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = '#E4E4E7';
      const size = Math.max(8, Math.min(labelHeight, width * 0.16));
      context.font = `500 ${size}px system-ui, sans-serif`;
      context.fillText(label(), cx, height - labelHeight / 2 - 2);
    },

    onPropsChanged(props) {
      if (typeof props.on === 'boolean') on = props.on;
      api.invalidate();
    },
  };
}

/** `#RRGGBB` plus an alpha byte, for the glow ring. */
function hexWithAlpha(value, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match === null) return 'rgba(239, 68, 68, 0.22)';
  const byte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${match[1]}${byte}`;
}
