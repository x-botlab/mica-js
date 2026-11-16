/**
 * 两脚抽象轻触开关：按下由公共方法提交，模型在两端之间建立 1 Ω 支路；
 * 松开移除该支路，两端保持悬空，不再用 1 GΩ 假闭合。
 */
export const create: DeviceFactory = (context) => {
  let pressed = false;

  const methods: DeviceMethods = {
    press: (value) => {
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
