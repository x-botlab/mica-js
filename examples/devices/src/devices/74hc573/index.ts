import type { Factory } from './model.ddl';

/** 把锁存字节发布到同名话题；输出通道用于批次内观察，话题用于 UI 绑定。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.latch;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('latch', latest.value);
  },
  dispose() {},
});

export default create;
