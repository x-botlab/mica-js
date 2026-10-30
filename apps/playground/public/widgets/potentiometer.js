function normalized(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

export default function potentiometer(api) {
  let position = normalized(api.props.initialPosition) ?? 0.5;
  let dragging = false;
  let disposed = false;
  let pending;
  let feedbackTime = -Infinity;

  const unsubscribe = api.subscribe('actualPosition', (payload, meta) => {
    const next = normalized(payload);
    if (disposed || next === undefined || !Number.isFinite(meta?.simTime)) return;
    if (meta.simTime < feedbackTime) return;
    feedbackTime = meta.simTime;
    // Level ports can coalesce intermediate commands. Only the latest target acknowledges a drag.
    if (pending !== undefined && next !== pending) return;
    pending = undefined;
    if (dragging || next === position) return;
    position = next;
    api.invalidate();
  });

  function geometry() {
    const width = api.width;
    const height = api.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      return undefined;
    const inset = Math.min(12, width / 4);
    return { width, height, inset, span: width - inset * 2, y: height * 0.68 };
  }

  function setPosition(next) {
    if (next === position) return;
    position = next;
    pending = next;
    api.invalidate();
    // Omit simTime: the host supplies its current simulation clock.
    api.publish('position', next);
  }

  function move(event) {
    const layout = geometry();
    if (layout === undefined || typeof event.x !== 'number' || !Number.isFinite(event.x)) return;
    setPosition(Math.max(0, Math.min(1, (event.x - layout.inset) / layout.span)));
  }

  return {
    render(context) {
      if (disposed) return;
      const layout = geometry();
      if (layout === undefined) return;
      const { width, height, inset, span, y } = layout;
      const radius = Math.min(7, height * 0.14, inset);
      context.save();
      context.clearRect(0, 0, width, height);
      context.beginPath();
      context.rect(0, 0, width, height);
      context.clip();

      const size = Math.min(12, height * 0.24);
      const value = `${Math.round(position * 100)}%`;
      context.font = `600 ${size}px system-ui, sans-serif`;
      context.textBaseline = 'middle';
      context.fillStyle = '#e4e4e7';
      context.textAlign = 'right';
      const valueWidth = Math.min(context.measureText(value).width, span * 0.4);
      context.fillText(value, width - inset, height * 0.23, valueWidth);
      const labelWidth = span - valueWidth - Math.min(8, span * 0.1);
      if (labelWidth > 0) {
        context.textAlign = 'left';
        const label = typeof api.props.label === 'string' ? api.props.label : 'Position';
        context.fillText(label, inset, height * 0.23, labelWidth);
      }

      context.lineWidth = Math.min(4, radius);
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(inset, y);
      context.lineTo(width - inset, y);
      context.strokeStyle = '#71717a';
      context.stroke();
      const x = inset + span * position;
      context.beginPath();
      context.moveTo(inset, y);
      context.lineTo(x, y);
      context.strokeStyle = '#34d399';
      context.stroke();
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = dragging ? '#ffffff' : '#e4e4e7';
      context.fill();
      context.lineWidth = Math.min(2, radius / 2);
      context.strokeStyle = '#059669';
      context.stroke();
      context.restore();
    },
    input(event) {
      if (disposed) return;
      if (event.type === 'pointerdown') {
        if (event.button !== undefined && event.button !== 0) return;
        const layout = geometry();
        if (
          dragging ||
          layout === undefined ||
          !Number.isFinite(event.x) ||
          !Number.isFinite(event.y) ||
          event.x < 0 ||
          event.x > layout.width ||
          event.y < 0 ||
          event.y > layout.height
        )
          return;
        dragging = true;
        move(event);
        api.invalidate();
      } else if (event.type === 'pointermove' && dragging) {
        move(event);
      } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
        if (!dragging) return;
        if (event.type === 'pointerup') move(event);
        // Cancellation ends capture without rolling back an already published device command.
        dragging = false;
        api.invalidate();
      } else if (
        event.type === 'keydown' &&
        !dragging &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const step = event.shiftKey ? 0.1 : 0.01;
        let next;
        switch (event.key) {
          case 'ArrowRight':
          case 'ArrowUp':
            next = position + step;
            break;
          case 'ArrowLeft':
          case 'ArrowDown':
            next = position - step;
            break;
          case 'Home':
            next = 0;
            break;
          case 'End':
            next = 1;
            break;
          default:
            return;
        }
        setPosition(Math.max(0, Math.min(1, Number(next.toFixed(12)))));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dragging = false;
      unsubscribe();
    },
  };
}
