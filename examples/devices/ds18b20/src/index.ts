/**
 * 环境温度由公共方法注入；转换完成后的读数由模型输出。
 * 未完成任何转换时 `hasTemperature()` 为 false，`getTemperature()` 返回注入的默认环境温度。
 */
export const create: DeviceFactory = (context) => {
  let temperature = 25;
  let converted = false;

  const methods: DeviceMethods = {
    setTemperature: (value) => {
      context.inputs.temperature.send(value);
      return null;
    },
    hasTemperature: () => converted,
    getTemperature: () => temperature,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.temperatureOut) {
        temperature = message.value;
        converted = true;
        context.events.onDidTemperatureOut.fire(temperature);
      }
    },
    dispose() {},
  };
};
