import type { Factory } from './model.ddl';

/** 跳线是纯电气器件：没有端口，也没有批次输出。 */
const create: Factory = () => ({ sync() {}, dispose() {} });

export default create;
