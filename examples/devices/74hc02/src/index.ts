/**
 * 74HC02 没有公共输出状态；门电路的电平完全由引脚网络决定。
 * 适配器只保留生命周期，不转发旧端口。
 */
export const create: DeviceFactory = () => ({
  methods: {},
  sync() {},
  dispose() {},
});
