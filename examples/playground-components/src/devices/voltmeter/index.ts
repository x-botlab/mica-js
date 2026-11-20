import type { Factory } from './model.ddl';

const create: Factory = (context) => {
  let voltage = 0;
  return {
    sync(batch) {
      for (const message of batch.outputs.voltage) voltage = message.value;
      context.topics.publish('voltage', voltage);
    },
    dispose() {},
  };
};
export default create;
