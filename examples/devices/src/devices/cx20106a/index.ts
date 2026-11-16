import type { Factory } from './model.ddl';

/** 把解调状态发布到同名话题；重复电平和被取消的定时不会产生消息。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.receiving;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('receiving', latest.value);
  },
  dispose() {},
});

export default create;
