import { MethodError } from '@mica-js/sdk/fused';

/**
 * 缓存内部电位器位置与最近一次发布的增益。设置位置通过输入通道提交；公共方法
 * 负责有限越界钳位，DDL 负责通道边界校验、增益计算和输出驱动。增益事件只在值
 * 变化时发布，启动时先发布一次初值。
 */
export const create: DeviceFactory = (context) => {
  const clampPosition = (value: number): number => Math.min(1, Math.max(0, value));
  // 与 model.ddl 的 gainFor 使用同一映射；DDL 是行为权威来源，这里只提供启动查询值。
  const gainFor = (position: number): number => {
    const effective =
      context.props.minPotResistance +
      (context.props.potResistance - context.props.minPotResistance) * (1 - position);
    return 1 + (2 * context.props.feedbackResistance) / effective;
  };

  let position = clampPosition(context.props.initialWiper);
  let gain = gainFor(position);

  const methods: DeviceMethods = {
    setWiper: (value) => {
      if (!Number.isFinite(value))
        throw new MethodError(
          'lm324/invalid-wiper',
          'wiper position must be a finite value within 0..1',
          null,
        );
      context.inputs.setWiper.send(clampPosition(value));
      return null;
    },
    getWiper: () => position,
    getGain: () => gain,
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.setting) {
        position = message.value.position;
        gain = message.value.gain;
        context.events.onDidSetting.fire(message.value);
      }
    },
    dispose() {},
  };
};
