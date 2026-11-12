import type { Factory } from './model.ddl';

/** 把折叠后的频率与占空比发布到同名话题；两者只在启动时各发一次。 */
const create: Factory = (context) => ({
  sync(batch) {
    for (const name of ['frequency', 'dutyCycle'] as const) {
      const messages = batch.outputs[name];
      const latest = messages[messages.length - 1];

      if (latest !== undefined) context.topics.publish(name, latest.value);
    }
  },
  dispose() {},
});

export default create;
