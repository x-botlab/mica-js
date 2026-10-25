export default function voltmeter(api) {
  let voltage = 0;
  let hasReading = false;

  const label = () => (typeof api.props.label === 'string' ? api.props.label : '电压表');
  const color = () => (typeof api.props.color === 'string' ? api.props.color : '#22D3EE');
  const decimals = () => {
    const value = api.props.decimals;
    return typeof value === 'number' && value >= 0 && value <= 3 ? Math.round(value) : 2;
  };
  const fullScale = () => {
    const value = api.props.maxVoltage;
    return typeof value === 'number' && value > 0 ? value : 3.3;
  };

  api.subscribe('value', (payload) => {
    if (typeof payload !== 'number' || !Number.isFinite(payload)) return;
    // A device re-publishes every tick; repainting an unchanged reading is wasted work.
    if (hasReading && Math.abs(payload - voltage) < 1e-6) return;
    voltage = payload;
    hasReading = true;
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;
      context.clearRect(0, 0, width, height);

      const padding = 10;
      const labelSize = Math.max(9, Math.min(height * 0.16, 15));
      const valueSize = Math.max(14, Math.min(height * 0.3, 30));
      const barTop = height - padding - labelSize - 8;

      context.textAlign = 'left';
      context.textBaseline = 'top';
      context.fillStyle = '#A1A1AA';
      context.font = `500 ${labelSize}px system-ui, sans-serif`;
      context.fillText(label(), padding, padding);

      context.fillStyle = color();
      context.font = `600 ${valueSize}px system-ui, monospace`;
      const reading = hasReading ? voltage.toFixed(decimals()) : '—';
      context.fillText(`${reading} V`, padding, padding + labelSize + 4);

      // Bar: solved voltage against the widget's full scale.
      const track = { x: padding, y: barTop, width: width - padding * 2, height: 6 };
      context.fillStyle = 'rgba(161, 161, 170, 0.25)';
      context.fillRect(track.x, track.y, track.width, track.height);

      const ratio = Math.min(Math.max(voltage / fullScale(), 0), 1);
      context.fillStyle = color();
      context.fillRect(track.x, track.y, track.width * ratio, track.height);
    },

    onPropsChanged() {
      api.invalidate();
    },
  };
}
