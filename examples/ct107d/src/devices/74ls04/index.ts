import type { Factory } from './model.ddl';

/** 纯胶水逻辑，没有输出端口；适配器只实现生命周期。 */
const create: Factory = () => ({
  sync() {},
  dispose() {},
});

export default create;
