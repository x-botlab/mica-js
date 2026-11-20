/** 缓存最近一次差分电压；事件只在模型发布新采样时发出。 */
export const create: DeviceFactory = (context) => {
  let voltage = 0;

  const methods: DeviceMethods = {
    getVoltage: () => voltage,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.voltage) {
        voltage = message.value;
        context.events.onDidVoltage.fire(voltage);
      }
    },
    dispose() {},
  };
};
