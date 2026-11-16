/** 超声波模块没有公共输出状态；全部行为由 TRIG/ECHO 引脚时序表达。 */
export const create: DeviceFactory = () => ({
  methods: {},
  sync() {},
  dispose() {},
});
