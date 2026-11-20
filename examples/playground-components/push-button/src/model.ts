/** 公共方法提交按下状态；模型在通道消费后回传 `pressed` 并发出事件。 */
export const create: DeviceFactory = (context) => {
  let pressed = false;

  const methods: DeviceMethods = {
    press: (value) => {
      if (typeof value !== 'boolean') throw new TypeError('press expects a boolean');
      context.inputs.press.send(value);
      return null;
    },
    isPressed: () => pressed,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.pressed) {
        pressed = message.value;
        context.events.onDidPress.fire(pressed);
      }
    },
    dispose() {},
  };
};
