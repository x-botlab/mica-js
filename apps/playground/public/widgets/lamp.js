/** Numeric brightness takes precedence once received; boolean-only bindings still work. */
function colorOf(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function roundedPath(context, width, height, radius) {
  context.beginPath();
  if (radius <= 0) {
    context.rect(0, 0, width, height);
    return;
  }
  if (typeof context.roundRect === 'function') {
    context.roundRect(0, 0, width, height, radius);
    return;
  }
  context.moveTo(radius, 0);
  context.lineTo(width - radius, 0);
  context.arcTo(width, 0, width, radius, radius);
  context.lineTo(width, height - radius);
  context.arcTo(width, height, width - radius, height, radius);
  context.lineTo(radius, height);
  context.arcTo(0, height, 0, height - radius, radius);
  context.lineTo(0, radius);
  context.arcTo(0, 0, radius, 0, radius);
  context.closePath();
}

export default function lamp(api) {
  let lit = false;
  let brightness;

  api.subscribe('brightness', (payload) => {
    if (typeof payload !== 'number' || !Number.isFinite(payload)) return;
    brightness = Math.min(1, Math.max(0, payload));
    api.invalidate();
  });

  api.subscribe('lit', (payload) => {
    lit = payload === true;
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;

      const radius = Math.min(
        Math.max(Number(api.props.radius) || 0, 0),
        Math.min(width, height) / 2,
      );
      const on = colorOf(api.props.color, '#FF3B30');
      const off = colorOf(api.props.offColor, '#27272A');
      const level = brightness ?? (lit ? 1 : 0);

      context.clearRect(0, 0, width, height);
      context.save();
      roundedPath(context, width, height, radius);
      context.fillStyle = '#0C0A09';
      context.fill();
      context.restore();

      const label =
        api.props.label === undefined || api.props.label === null ? '' : String(api.props.label);
      const size = Math.min(width, height) * (label.length > 0 ? 0.5 : 0.66);
      const cx = width / 2;
      const cy = label.length > 0 ? height * 0.42 : height / 2;
      const glow = Math.max(4, size * 0.35) * level;

      context.save();
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.beginPath();
      context.arc(cx, cy, size / 2, 0, Math.PI * 2);
      context.fillStyle = off;
      context.fill();
      if (level > 0) {
        context.globalAlpha = level;
        context.shadowColor = on;
        context.shadowBlur = glow;
        context.fillStyle = on;
        context.fill();
      }
      context.restore();

      // A highlight keeps the lamp readable when it is off.
      context.beginPath();
      context.arc(cx - size * 0.15, cy - size * 0.15, size * 0.16, 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 255, 255, ${0.12 + 0.43 * level})`;
      context.fill();

      if (label.length === 0) return;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `600 ${Math.max(8, Math.min(height * 0.16, width * 0.2))}px system-ui, sans-serif`;
      context.fillStyle = level > 0 ? '#f4f4f5' : '#a1a1aa';
      context.fillText(label, width / 2, height * 0.84);
    },
    dispose() {
      // Nothing to release: the lamp owns no textures or audio.
    },
  };
}
