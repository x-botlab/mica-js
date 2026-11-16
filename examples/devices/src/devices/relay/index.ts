import type { Factory } from './model.ddl';

/** 把模型的 `energized` 输出发布到同名话题；每批次取最后一条，订阅方拿到当前状态。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.energized;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('energized', latest.value);
  },
  dispose() {},
});

export default create;
