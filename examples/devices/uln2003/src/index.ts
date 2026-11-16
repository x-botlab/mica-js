/**
 * 缓存七路输入掩码与七字节状态串；`channels` 查询和事件都交付独立字节快照。
 */
export const create: DeviceFactory = (context) => {
  let mask = 0;
  let channels = new Uint8Array(0);

  const methods: DeviceMethods = {
    getMask: () => mask,
    getChannels: () => new Uint8Array(channels),
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.mask) {
        mask = message.value;
        context.events.onDidMask.fire(mask);
      }
      for (const message of batch.outputs.channels) {
        channels = new Uint8Array(message.value.slice());
        context.events.onDidChannels.fire(new Uint8Array(channels));
      }
    },
    dispose() {},
  };
};
