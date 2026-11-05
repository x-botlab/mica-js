/** Self-contained button widget: pointer presses publish on the `press` output port. */
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

export default function demoButton(api) {
  let pressed = false;

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;

      const radius = Math.min(Math.max(Number(api.props.radius) || 0, 0), width / 2, height / 2);
      const background =
        typeof api.props.background === 'string' && api.props.background.length > 0
          ? api.props.background
          : '#3F3F46';
      const active =
        typeof api.props.activeColor === 'string' && api.props.activeColor.length > 0
          ? api.props.activeColor
          : '#0EA5E9';

      context.clearRect(0, 0, width, height);
      context.save();
      roundedPath(context, width, height, radius);
      context.fillStyle = pressed ? active : background;
      context.fill();
      context.restore();

      const label =
        api.props.label === undefined || api.props.label === null ? '' : String(api.props.label);
      if (label.length === 0) return;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `600 ${Math.max(9, Math.min(height * 0.3, width * 0.18))}px system-ui, sans-serif`;
      context.fillStyle = '#F4F4F5';
      context.fillText(label, width / 2, height / 2);
    },
    input(event) {
      if (event.type === 'pointerdown') {
        pressed = true;
        api.invalidate();
        api.publish('press', true);
        return;
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        pressed = false;
        api.invalidate();
        api.publish('press', false);
      }
    },
  };
}
