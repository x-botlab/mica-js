/**
 * 缓存模型的亮度、正向电流与正向电压，并提供查询与变化事件。
 * 模型只在采样变化时发送通道消息，查询返回最近一次接收的完整状态。
 */
export const create: DeviceFactory = (context) => {
  let brightness = 0;
  let current = 0;
  let voltage = 0;

  const methods: DeviceMethods = {
    getBrightness: () => brightness,
    getCurrent: () => current,
    getVoltage: () => voltage,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.brightness) {
        brightness = message.value;
        context.events.onDidBrightness.fire(brightness);
      }
      for (const message of batch.outputs.current) {
        current = message.value;
        context.events.onDidCurrent.fire(current);
      }
      for (const message of batch.outputs.voltage) {
        voltage = message.value;
        context.events.onDidVoltage.fire(voltage);
      }
    },
    dispose() {},
  };
};
