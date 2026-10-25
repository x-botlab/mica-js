export default function potentiometer(api) {
  const maxVoltage = Math.max(0.1, Number(api.props.maxVoltage) || 3.3);
  const label = typeof api.props.label === 'string' ? api.props.label : '电位器';
  const color = typeof api.props.color === 'string' ? api.props.color : '#38BDF8';

  /** Knob position in [0, 1]; the analogue quantity this part outputs. */
  let position = clamp01(Number(api.props.initial));
  /** Where the knob is heading; `tick` eases towards it so drags stay smooth. */
  let target = position;
  /** Last voltage actually published, so a still knob stops talking. */
  let published = -1;
  let dragging = false;
  let sincePublish = 0;

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
  }

  function track() {
    const pad = Math.max(14, Math.min(api.width, api.height) * 0.16);
    return {
      left: pad,
      right: Math.max(pad + 1, api.width - pad),
      y: api.height * 0.46,
      height: Math.max(6, api.height * 0.12),
    };
  }

  function knobAt(x) {
    const { left, right } = track();
    return clamp01((x - left) / Math.max(1, right - left));
  }

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;
      const { left, right, y, height: barHeight } = track();

      context.clearRect(0, 0, width, height);

      // Track
      context.fillStyle = 'rgba(148, 163, 184, 0.18)';
      rounded(context, left, y - barHeight / 2, right - left, barHeight, barHeight / 2);
      context.fill();

      // Filled part up to the knob
      const knobX = left + (right - left) * position;
      const knobRadius = Math.max(8, Math.min(height * 0.18, (right - left) * 0.06));
      context.fillStyle = color;
      rounded(
        context,
        left,
        y - barHeight / 2,
        Math.max(barHeight, knobX - left),
        barHeight,
        barHeight / 2,
      );
      context.fill();

      // Knob
      context.beginPath();
      context.arc(knobX, y, knobRadius, 0, Math.PI * 2);
      context.fillStyle = '#0F172A';
      context.fill();
      context.lineWidth = Math.max(2, knobRadius * 0.32);
      context.strokeStyle = color;
      context.stroke();

      // Readout
      const volts = position * maxVoltage;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = '#F4F4F5';
      const valueSize = Math.max(11, Math.min(height * 0.24, width * 0.16));
      context.font = `600 ${valueSize}px ui-monospace, monospace`;
      context.fillText(`${volts.toFixed(2)} V`, width / 2, y - barHeight / 2 - valueSize * 0.75);

      context.fillStyle = 'rgba(161, 161, 170, 0.9)';
      const labelSize = Math.max(9, Math.min(height * 0.12, width * 0.1));
      context.font = `500 ${labelSize}px system-ui, sans-serif`;
      context.fillText(label, width / 2, y + barHeight / 2 + labelSize * 1.1);
    },

    input(event) {
      if (event.type === 'pointerdown') {
        dragging = true;
        target = knobAt(Number(event.x) || 0);
        return;
      }
      if (event.type === 'pointermove' && dragging) {
        target = knobAt(Number(event.x) || 0);
        return;
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        dragging = false;
      }
    },

    /**
     * Smooths the knob towards the pointer and publishes the voltage.
     *
     * The easing is what makes a drag look continuous: pointer moves arrive at
     * display rate, so `target` can jump, while `position` is what the analogue
     * output follows. Publishing is rate-limited to 25 Hz, which keeps a slow
     * MCU sample loop from being flooded.
     */
    tick(deltaMs) {
      const delta = Number.isFinite(deltaMs) ? Math.max(0, Math.min(deltaMs, 100)) : 16;
      const distance = target - position;
      if (Math.abs(distance) > 0.0005) {
        position = clamp01(position + distance * Math.min(1, delta / 90));
        api.invalidate();
      } else if (position !== target) {
        position = target;
        api.invalidate();
      }

      sincePublish += delta;
      const volts = position * maxVoltage;
      const moved = Math.abs(volts - published) >= 0.005;
      if (moved && sincePublish >= 40) {
        sincePublish = 0;
        published = volts;
        api.publish('voltage', volts, 0);
      }
    },
  };
}

function rounded(context, x, y, width, height, radius) {
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, Math.max(0, width), Math.max(0, height), radius);
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
