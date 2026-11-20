/** 电阻没有动态状态；电气支路由 DDL 声明的属性决定。 */
export const create: DeviceFactory = () => {
  const methods: DeviceMethods = {};
  return { methods, sync() {}, dispose() {} };
};
