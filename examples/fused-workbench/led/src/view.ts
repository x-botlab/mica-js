interface ILedViewContext {
  readonly model: DeviceClient | undefined;
  invalidate(): void;
}

export default function createView(context: ILedViewContext) {
  let brightness = 0;
  const subscription = context.model?.events.onDidBrightnessChange((event) => {
    brightness = event.value;
    context.invalidate();
  });
  return {
    async initialize() {
      brightness = (await context.model?.methods.getBrightness(null)) ?? 0;
      context.invalidate();
    },
    renderOverlay(canvas: OffscreenCanvasRenderingContext2D) {
      canvas.fillStyle = brightness > 0.5 ? '#ff4857' : '#74252e';
      canvas.beginPath();
      canvas.arc(5, 4, 2.6, 0, Math.PI * 2);
      canvas.fill();
      if (brightness > 0.5) {
        canvas.fillStyle = '#ffc2c9';
        canvas.beginPath();
        canvas.arc(4.2, 3.2, 0.7, 0, Math.PI * 2);
        canvas.fill();
      }
    },
    dispose() {
      subscription?.dispose();
    },
  };
}
