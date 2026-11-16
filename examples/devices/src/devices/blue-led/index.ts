import type { Factory } from './model.ddl';

/**
 * 把模型的输出通道发布到同名话题。
 *
 * 模型只在采样变化时发送，适配器取每个批次里同名的最后一条，因此订阅方拿到的是
 * 当前状态而不是逐条历史（`delivery: level`）。
 */
const create: Factory = (context) => ({
  sync(batch) {
    for (const name of ['brightness', 'current', 'voltage'] as const) {
      const messages = batch.outputs[name];
      const latest = messages[messages.length - 1];

      if (latest !== undefined) context.topics.publish(name, latest.value);
    }
  },
  dispose() {},
});

export default create;
