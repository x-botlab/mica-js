export const create: DeviceFactory = (context) => {
  let pressed = false;
  context.events.onDidPressedChange.fire(pressed);
  return {
    methods: {
      press(value) {
        pressed = value;
        context.inputs.pressed.send(value);
        context.events.onDidPressedChange.fire(value);
        return null;
      },
      getPressed: () => pressed,
    },
    sync() {},
    dispose() {},
  };
};
