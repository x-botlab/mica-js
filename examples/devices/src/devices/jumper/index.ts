import type { Factory } from './model.ddl';

/** 把当前闭合状态发布到话题；`control` 输入由 DDL 进程直接消费。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.closedState;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('closedState', latest.value);
  },
  dispose() {},
});

export default create;
