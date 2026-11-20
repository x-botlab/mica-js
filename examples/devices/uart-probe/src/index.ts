/**
 * 注入字节由公共方法提交；接收复原字节与注入完成字节逐条发出事件。
 * 每条事件携带独立的 `Uint8Array`，一个批次里的多个字节不会被折叠。
 */
export const create: DeviceFactory = (context) => {
  const methods: DeviceMethods = {
    send: (bytes) => {
      context.inputs.send.send(bytes);
      return null;
    },
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.tx)
        context.events.onDidTx.fire(new Uint8Array(message.value.slice()));
      for (const message of batch.outputs.rx)
        context.events.onDidRx.fire(new Uint8Array(message.value.slice()));
    },
    dispose() {},
  };
};
