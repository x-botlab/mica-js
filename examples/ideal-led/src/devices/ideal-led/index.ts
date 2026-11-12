import type { Factory } from './model.ddl';

const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.brightness ?? [];
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('brightness', latest.value);
  },
  dispose() {},
});

export default create;
