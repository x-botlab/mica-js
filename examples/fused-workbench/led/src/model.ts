export const create: DeviceFactory = (context) => {
  let brightness = 0;
  context.events.onDidBrightnessChange.fire(brightness);
  return {
    methods: { getBrightness: () => brightness },
    sync(batch) {
      for (const message of batch.outputs.brightness ?? []) {
        brightness = message.value;
        context.events.onDidBrightnessChange.fire(brightness);
      }
    },
    dispose() {},
  };
};
