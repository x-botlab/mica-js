import type { Factory } from './model.ddl';

/** 把通道 2 当前选择发布到话题；`control2` 输入由 DDL 进程直接消费。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.closedState2;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('closedState2', latest.value);
  },
  dispose() {},
});

export default create;
