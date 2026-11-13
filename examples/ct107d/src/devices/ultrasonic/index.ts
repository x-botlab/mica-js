import type { Factory } from './model.ddl';

/** 行为完全由引脚和 DDL 定时过程驱动；适配器没有可发布端口。 */
const create: Factory = () => ({
  sync() {},
  dispose() {},
});

export default create;
