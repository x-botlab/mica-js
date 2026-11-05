import type { WidgetFactory } from '@mica-js/sdk/widget';

const create: WidgetFactory = (api) => {
  let brightness = 0;
  const unsubscribe = api.subscribe('brightness', (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    brightness = Math.max(0, Math.min(1, value));
    api.invalidate();
  });
  return {
    render(ctx) {
      ctx.fillStyle = '#22aa55';
      ctx.globalAlpha = brightness;
      ctx.fillRect(0, 0, api.width, api.height);
    },
    dispose() {
      unsubscribe();
    },
  };
};

export default create;
