/**
 * 缓存走时时间与走时状态。`datetime` 是 19 字节 ASCII，
 * 查询和事件都交付独立的 `Uint8Array` 快照。
 */
export const create: DeviceFactory = (context) => {
  let datetime = new Uint8Array(0);
  let running = false;

  const methods: DeviceMethods = {
    getDatetime: () => new Uint8Array(datetime),
    isRunning: () => running,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.datetime) {
        datetime = new Uint8Array(message.value.slice());
        context.events.onDidDatetime.fire(new Uint8Array(datetime));
      }
      for (const message of batch.outputs.running) {
        running = message.value;
        context.events.onDidRunning.fire(running);
      }
    },
    dispose() {},
  };
};
