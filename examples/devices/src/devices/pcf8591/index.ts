import type { Factory } from './model.ddl';

/** 把 DAC 值与当前通道转发到同名话题。 */
const create: Factory = (context) => ({
  sync(batch) {
    for (const name of ['aout', 'channel'] as const) {
      const messages = batch.outputs[name];
      const latest = messages[messages.length - 1];

      if (latest !== undefined) context.topics.publish(name, latest.value);
    }
  },
  dispose() {},
});

export default create;
