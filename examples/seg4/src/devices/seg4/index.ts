import type { Factory } from './model.ddl';

/** 把四位段码发布到同名话题；没有新值的批次不重复发布。 */
const DIGITS = ['digit1', 'digit2', 'digit3', 'digit4'] as const;

const create: Factory = (context) => ({
  sync(batch) {
    for (const name of DIGITS) {
      const messages = batch.outputs[name];
      const latest = messages[messages.length - 1];

      if (latest !== undefined) context.topics.publish(name, latest.value);
    }
  },
  dispose() {},
});

export default create;
