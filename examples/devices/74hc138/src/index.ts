/**
 * 把译码结果缓存为公共状态，并通过事件报告每次变化。
 * `code` 是两字节 ASCII；事件和查询都交付独立的 `Uint8Array` 快照。
 */
export const create: DeviceFactory = (context) => {
  let select = -1;
  let enabled = false;
  let code = new Uint8Array(0);

  const methods: DeviceMethods = {
    getSelect: () => select,
    isEnabled: () => enabled,
    getCode: () => new Uint8Array(code),
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.select) {
        select = message.value;
        context.events.onDidSelect.fire(select);
      }
      for (const message of batch.outputs.enabled) {
        enabled = message.value;
        context.events.onDidEnabled.fire(enabled);
      }
      for (const message of batch.outputs.code) {
        code = new Uint8Array(message.value.slice());
        context.events.onDidCode.fire(new Uint8Array(code));
      }
    },
    dispose() {},
  };
};
