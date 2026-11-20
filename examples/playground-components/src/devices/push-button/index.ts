import type { Factory } from './model.ddl';

const create: Factory = (context) => {
  let previous = false;
  const subscription = context.topics.onDidReceive(({ topic, payload }) => {
    if (topic !== 'press' || typeof payload !== 'boolean' || payload === previous) return;
    context.inputs.press.send(payload);
    previous = payload;
  });
  return { sync() {}, dispose: () => subscription.dispose() };
};
export default create;
