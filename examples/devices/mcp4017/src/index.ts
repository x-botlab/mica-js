import { MethodError } from '@mica-js/sdk/fused';

/**
 * 缓存 wiper 码、W–B 电阻与最近一次有效滑臂电压。尚未得到有效采样时
 * `getVoltage` 抛出可恢复的 `MethodError`，不返回会与真实 0 V 混淆的占位值。
 */
export const create: DeviceFactory = (context) => {
  let wiper = 0x3f;
  let resistance = (context.props.rab * 0x3f) / 127 + context.props.wiperResistance;
  let voltage: number | undefined;

  const methods: DeviceMethods = {
    getWiper: () => wiper,
    getResistance: () => resistance,
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
      for (const message of batch.outputs.wiper) {
        wiper = message.value;
        context.events.onDidWiper.fire(wiper);
      }
      for (const message of batch.outputs.resistance) {
        resistance = message.value;
        context.events.onDidResistance.fire(resistance);
      }
      for (const message of batch.outputs.voltage) {
        voltage = message.value;
        context.events.onDidVoltage.fire(voltage);
      }
    },
    dispose() {},
  };
};
