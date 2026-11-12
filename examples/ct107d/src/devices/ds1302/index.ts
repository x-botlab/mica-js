import type { Factory } from './model.ddl';

/** 把走时字节与走时状态发布到同名话题；输出通道用于批次内观察，话题用于 UI 绑定。 */
const create: Factory = (context) => ({
  sync(batch) {
    for (const name of ['datetime', 'running'] as const) {
      const messages = batch.outputs[name];
      const latest = messages[messages.length - 1];

      if (latest !== undefined) context.topics.publish(name, latest.value);
    }
  },
  dispose() {},
});

export default create;
