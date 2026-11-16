/**
 * 74HC14 没有公共输出状态；迟滞后的电平由引脚网络体现。
 * 适配器只保留生命周期，不转发旧端口。
 */
export const create: DeviceFactory = () => ({
  methods: {},
  sync() {},
  dispose() {},
});
