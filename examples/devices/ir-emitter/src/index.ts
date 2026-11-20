/** 载波请求由公共方法提交；逻辑载波状态由模型输出并缓存。 */
export const create: DeviceFactory = (context) => {
  let carrier = false;

  const methods: DeviceMethods = {
    setCarrier: (enabled) => {
      context.inputs.request.send(enabled);
      return null;
    },
    isCarrier: () => carrier,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.carrier) {
        carrier = message.value;
        context.events.onDidCarrier.fire(carrier);
      }
    },
    dispose() {},
  };
};
