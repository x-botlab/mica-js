export default function animation(api) {
  let angle = 0;
  let speed = Number(api.props.speed);
  let sides = Number(api.props.sides);
  let layout = {
    cx: api.width / 2,
    cy: api.height / 2,
    radius: Math.min(api.width, api.height) * 0.32,
  };

  function relayout() {
    const pad = Math.max(10, Math.min(api.width, api.height) * 0.14);
    layout = {
      cx: api.width / 2,
      cy: api.height / 2,
      radius: Math.max(4, Math.min(api.width, api.height) / 2 - pad),
    };
  }

  function normaliseSpeed(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, -8), 8) : 1;
  }

  function normaliseSides(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(Math.max(number, 3), 12) : 5;
  }

  relayout();
  speed = normaliseSpeed(api.props.speed);
  sides = normaliseSides(api.props.sides);

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;
      context.clearRect(0, 0, width, height);
      context.fillStyle =
        typeof api.props.background === 'string' ? api.props.background : '#18181B';
      context.fillRect(0, 0, width, height);

      const color = typeof api.props.color === 'string' ? api.props.color : '#F472B6';
      const { cx, cy, radius } = layout;

      // Orbit ring: a static reference so the spin is readable.
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.strokeStyle = 'rgba(148, 163, 184, 0.18)';
      context.lineWidth = 1;
      context.stroke();

      // The polygon itself.
      context.beginPath();
      for (let corner = 0; corner < sides; corner += 1) {
        const theta = angle + (corner / sides) * Math.PI * 2;
        const x = cx + Math.cos(theta) * radius * 0.82;
        const y = cy + Math.sin(theta) * radius * 0.82;
        if (corner === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fillStyle = withAlpha(color, 0.22);
      context.fill();
      context.lineWidth = Math.max(1.5, radius * 0.06);
      context.strokeStyle = color;
      context.stroke();

      // A dot trailing the first vertex makes the direction of rotation obvious.
      const dotX = cx + Math.cos(angle) * radius;
      const dotY = cy + Math.sin(angle) * radius;
      context.beginPath();
      context.arc(dotX, dotY, Math.max(2, radius * 0.08), 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();

      // Speed readout, so `onPropsChanged` is visible without opening the panel.
      const size = Math.max(8, Math.min(height * 0.09, width * 0.07));
      context.fillStyle = 'rgba(244, 244, 245, 0.78)';
      context.font = `500 ${size}px ui-monospace, monospace`;
      context.textAlign = 'left';
      context.textBaseline = 'top';
      context.fillText(`${speed.toFixed(2)} rad/s`, 8, 6);
      context.fillText(`${sides} 边`, 8, 6 + size * 1.35);
    },

    /** One rotation per frame budget: the angle advances with real milliseconds. */
    tick(deltaMs) {
      const delta = Number.isFinite(deltaMs) ? Math.max(0, Math.min(deltaMs, 100)) : 16;
      if (speed === 0) return;
      angle = (angle + (speed * delta) / 1000) % (Math.PI * 2);
      api.invalidate();
    },

    /** Re-layout on every size change; the radius drives every drawn coordinate. */
    onResize() {
      relayout();
      api.invalidate();
    },

    onPropsChanged(props) {
      speed = normaliseSpeed(props.speed);
      sides = normaliseSides(props.sides);
      api.invalidate();
    },
  };
}

/** `#RRGGBB` plus an alpha byte; falls back to a translucent pink. */
function withAlpha(value, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match === null) return 'rgba(244, 114, 182, 0.22)';
  const byte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${match[1]}${byte}`;
}
