/** 缓存 OUT 的逻辑状态并提供查询与变化事件。 */
export const create: DeviceFactory = (context) => {
  let active = false;

  const methods: DeviceMethods = {
    isActive: () => active,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.active) {
        active = message.value;
        context.events.onDidActive.fire(active);
      }
    },
    dispose() {},
  };
};
