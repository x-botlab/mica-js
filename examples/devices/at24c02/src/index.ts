/**
 * 把 256 字节存储映像缓存为公共状态，并在变化时发出事件。
 * 模型通道交付只读字节，查询与事件使用独立快照。
 */
export const create: DeviceFactory = (context) => {
  let dump = new Uint8Array(0);

  const methods: DeviceMethods = {
    getDump: () => new Uint8Array(dump),
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.dump) {
        dump = new Uint8Array(message.value.slice());
        context.events.onDidDump.fire(new Uint8Array(dump));
      }
    },
    dispose() {},
  };
};
