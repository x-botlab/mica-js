import type { Factory } from './model.ddl';

const create: Factory = (context) => {
  let brightness = 0;
  let current = 0;
  let voltage = 0;
  return {
    sync(batch) {
      for (const message of batch.outputs.brightness) brightness = message.value;
      for (const message of batch.outputs.current) current = message.value;
      for (const message of batch.outputs.voltage) voltage = message.value;
      context.topics.publish('brightness', brightness);
      context.topics.publish('current', current);
      context.topics.publish('voltage', voltage);
    },
    dispose() {},
  };
};
export default create;
