/**
 * 理想 LED：不建立电气支路，只把阳极相对阴极的逻辑电平投影为亮度 0/1。
 * DDL 每 0.5 ms 采样一次；适配器只在亮度变化时发出 `onDidBrightness`。
 */
export const create: DeviceFactory = (context) => {
  let brightness = 0;

  const methods: DeviceMethods = {
    getBrightness: () => brightness,
  };

  return {
    methods,
    sync(batch) {
      const messages = batch.outputs.brightness;
      const latest = messages[messages.length - 1];
      if (latest === undefined || latest.value === brightness) return;
      brightness = latest.value;
      context.events.onDidBrightness.fire(brightness);
    },
    dispose() {},
  };
};
