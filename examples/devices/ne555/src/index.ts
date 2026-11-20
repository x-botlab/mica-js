/** 缓存在创建期按 rA/rB/c 折叠出的振荡频率与占空比。 */
export const create: DeviceFactory = (context) => {
  let frequency = 0;
  let dutyCycle = 0;

  const methods: DeviceMethods = {
    getFrequency: () => frequency,
    getDutyCycle: () => dutyCycle,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.frequency) {
        frequency = message.value;
        context.events.onDidFrequency.fire(frequency);
      }
      for (const message of batch.outputs.dutyCycle) {
        dutyCycle = message.value;
        context.events.onDidDutyCycle.fire(dutyCycle);
      }
    },
    dispose() {},
  };
};
