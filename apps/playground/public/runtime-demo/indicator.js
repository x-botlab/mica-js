/** Self-contained indicator widget: renders the boolean received on the `lit` input port. */
function colorOf(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export default function demoIndicator(api) {
  let lit = false;

  api.subscribe('lit', (payload) => {
    lit = payload === true;
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;

      const on = colorOf(api.props.color, '#22C55E');
      const off = colorOf(api.props.offColor, '#27272A');
      const label =
        api.props.label === undefined || api.props.label === null ? '' : String(api.props.label);
      const size = Math.min(width, height) * (label.length > 0 ? 0.56 : 0.72);
      const cx = width / 2;
      const cy = label.length > 0 ? height * 0.42 : height / 2;

      context.clearRect(0, 0, width, height);
      context.save();
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.beginPath();
      context.arc(cx, cy, size / 2, 0, Math.PI * 2);
      context.fillStyle = lit ? on : off;
      context.fill();
      if (lit) {
        context.globalAlpha = 0.35;
        context.shadowColor = on;
        context.shadowBlur = size * 0.45;
        context.fill();
        context.globalAlpha = 1;
      }
      context.restore();

      context.beginPath();
      context.arc(cx - size * 0.16, cy - size * 0.16, size * 0.15, 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 255, 255, ${lit ? 0.55 : 0.16})`;
      context.fill();

      if (label.length === 0) return;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `600 ${Math.max(9, Math.min(height * 0.12, width * 0.16))}px system-ui, sans-serif`;
      context.fillStyle = lit ? '#F4F4F5' : '#A1A1AA';
      context.fillText(label, width / 2, height * 0.86);
    },
  };
}
