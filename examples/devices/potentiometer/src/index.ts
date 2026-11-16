import { MethodError } from '@mica-js/sdk/device';

/**
 * 缓存滑臂位置与最近一次有效电压。公共方法同步校验位置并投递到 DDL；电压只在
 * 滑臂采样变化时由模型发布。尚未得到有效采样时 `getVoltage` 抛出可恢复的
 * `MethodError`，不返回会与真实 0 V 混淆的占位值。
 */
export const create: DeviceFactory = (context) => {
  let position = context.props.initialPosition;
  let voltage: number | undefined;

  const methods: DeviceMethods = {
    setPosition: (value) => {
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new MethodError(
          'potentiometer/invalid-position',
          'position must be a finite value within 0..1',
          Number.isFinite(value) ? { position: value } : null,
        );
      context.inputs.setPosition.send(value);
      return null;
    },
    getPosition: () => position,
    getVoltage: () => {
      if (voltage === undefined)
        throw new MethodError(
          'voltage/unavailable',
          'No valid wiper voltage sample is available yet',
        );
      return voltage;
    },
  };

  return {
    methods,
    sync(batch) {
      for (const message of batch.outputs.position) {
        position = message.value;
        context.events.onDidPosition.fire(position);
      }
      for (const message of batch.outputs.voltage) {
        voltage = message.value;
        context.events.onDidVoltage.fire(voltage);
      }
    },
    dispose() {},
  };
};
