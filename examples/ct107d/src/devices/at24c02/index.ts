import type { Factory } from './model.ddl';

/** 把 256 字节存储映像转发到同名话题。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.dump;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('dump', latest.value);
  },
  dispose() {},
});

export default create;
