import type { Factory } from './model.ddl';

/** 把转换完成温度发布到同名话题；输出通道用于批次内观察，话题用于 UI 绑定。 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.temperatureOut;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('temperatureOut', latest.value);
  },
  dispose() {},
});

export default create;
