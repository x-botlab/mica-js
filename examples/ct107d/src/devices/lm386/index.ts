import type { Factory } from './model.ddl';

/** 把 OUT 的高电平状态转发到 `active` 话题；输出通道用于批次内观察，话题用于 UI 绑定。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.active;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('active', latest.value);
  },
  dispose() {},
});

export default create;
