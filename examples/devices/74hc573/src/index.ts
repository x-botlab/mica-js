/** 把最近一次锁存字节缓存为公共状态，并在变化时发出事件。 */
export const create: DeviceFactory = (context) => {
  let latch = 0;

  const methods: DeviceMethods = {
    getLatch: () => latch,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.latch) {
        latch = message.value;
        context.events.onDidLatch.fire(latch);
      }
    },
    dispose() {},
  };
};
