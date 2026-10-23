export default function pushButton(api) {
  let pressed = false;

  function plate(context, width, height, radius) {
    context.beginPath();
    if (typeof context.roundRect === 'function') {
      context.roundRect(0, 0, width, height, radius);
      return;
    }
    context.rect(0, 0, width, height);
  }

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;

      const label = api.props.label === undefined ? 'S1' : String(api.props.label);
      const radius = Math.min(width, height) * 0.2;
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, pressed ? '#3f3f46' : '#52525b');
      gradient.addColorStop(1, pressed ? '#18181b' : '#27272a');

      context.fillStyle = gradient;
      plate(context, width, height, radius);
      context.fill();
      context.lineWidth = Math.max(1, Math.min(width, height) * 0.04);
      context.strokeStyle = pressed ? '#fafafa' : 'rgba(250, 250, 250, 0.35)';
      context.stroke();

      context.fillStyle = pressed ? '#ffffff' : '#e4e4e7';
      context.font = `600 ${Math.max(9, Math.min(width, height) * 0.3)}px system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, width / 2, height / 2 + (pressed ? 1 : 0));
    },
    input(event) {
      if (event.type === 'pointerdown') {
        pressed = true;
        api.invalidate();
        api.publish('press', true, 0);
        return;
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        pressed = false;
        api.invalidate();
        api.publish('press', false, 0);
      }
    },
  };
}
