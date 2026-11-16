/** 2×3 跳线排针：通道 1 固定短接，通道 2 通过方法在两条接收支路间切换。 */
export const create: DeviceFactory = (context) => {
  let vs1838 = context.props.vs1838;

  const methods: DeviceMethods = {
    selectVs1838: (value) => {
      context.inputs.control2.send(value);
      return null;
    },
    isVs1838: () => vs1838,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.closedState2) {
        vs1838 = message.value;
        context.events.onDidClosedState2.fire(vs1838);
      }
    },
    dispose() {},
  };
};
