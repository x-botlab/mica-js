/** 载波输入由公共方法提交；解调状态由模型输出并缓存供查询。 */
export const create: DeviceFactory = (context) => {
  let receiving = false;

  const methods: DeviceMethods = {
    setCarrier: (enabled) => {
      context.inputs.carrier.send(enabled);
      return null;
    },
    isReceiving: () => receiving,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.receiving) {
        receiving = message.value;
        context.events.onDidReceiving.fire(receiving);
      }
    },
    dispose() {},
  };
};
