/** 四路模拟输入由方法注入；DAC 值与当前通道由模型输出并缓存。 */
export const create: DeviceFactory = (context) => {
  let aout = 0;
  let channel = 0;

  const methods: DeviceMethods = {
    setAin0: (value) => {
      context.inputs.ain0.send(value);
      return null;
    },
    setAin1: (value) => {
      context.inputs.ain1.send(value);
      return null;
    },
    setAin2: (value) => {
      context.inputs.ain2.send(value);
      return null;
    },
    setAin3: (value) => {
      context.inputs.ain3.send(value);
      return null;
    },
    getAout: () => aout,
    getChannel: () => channel,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.aout) {
        aout = message.value;
        context.events.onDidAout.fire(aout);
      }
      for (const message of batch.outputs.channel) {
        channel = message.value;
        context.events.onDidChannel.fire(channel);
      }
    },
    dispose() {},
  };
};
