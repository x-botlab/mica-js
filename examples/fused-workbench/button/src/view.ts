interface IButtonViewContext {
  readonly props: DeviceProps;
  readonly model: DeviceClient | undefined;
  invalidate(): void;
}

export default function createView(context: IButtonViewContext) {
  let pressed = false;
  const subscription = context.model?.events.onDidPressedChange((event) => {
    pressed = event.value;
    context.invalidate();
  });
  return {
    async initialize() {
      pressed = (await context.model?.methods.getPressed(null)) ?? false;
      context.invalidate();
    },
    renderOverlay(canvas: OffscreenCanvasRenderingContext2D) {
      canvas.fillStyle = pressed ? '#e2a138' : '#f6cc68';
      canvas.beginPath();
      canvas.roundRect(1.6, 1.6, 6.8, 6.8, 1.2);
      canvas.fill();
      canvas.fillStyle = '#292823';
      canvas.textAlign = 'center';
      canvas.textBaseline = 'middle';
      canvas.font = '1.2px sans-serif';
      canvas.fillText(context.props.label ?? 'PRESS', 5, 5, 6);
    },
    async input(event: { readonly type: string }) {
      if (event.type === 'pointerdown') await context.model?.methods.press(true);
      else if (event.type === 'pointerup') await context.model?.methods.press(false);
    },
    dispose() {
      subscription?.dispose();
    },
  };
}
