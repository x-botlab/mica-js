/** 两脚跳线：初值来自属性，运行期通过方法切换；状态由模型输出。 */
export const create: DeviceFactory = (context) => {
  let closed = context.props.closed;

  const methods: DeviceMethods = {
    setClosed: (value) => {
      context.inputs.control.send(value);
      return null;
    },
    isClosed: () => closed,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.closedState) {
        closed = message.value;
        context.events.onDidClosedState.fire(closed);
      }
    },
    dispose() {},
  };
};
