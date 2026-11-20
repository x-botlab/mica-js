/** 缓存线圈吸合状态并提供查询与变化事件。 */
export const create: DeviceFactory = (context) => {
  let energized = false;

  const methods: DeviceMethods = {
    isEnergized: () => energized,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.energized) {
        energized = message.value;
        context.events.onDidEnergized.fire(energized);
      }
    },
    dispose() {},
  };
};
