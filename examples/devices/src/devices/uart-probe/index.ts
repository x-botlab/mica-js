import type { Factory } from './model.ddl';

/**
 * 把接收复原字节与注入完成字节逐条发布到同名话题。
 *
 * bytes 通道值在批次里是只读代理，话题契约要求真实 `Uint8Array`，所以每条消息都先
 * `slice()`。一个批次可能包含多个字节，不能只发布最后一条。
 */
const create: Factory = (context) => ({
  sync(batch) {
    for (const message of batch.outputs.tx) context.topics.publish('tx', message.value.slice());
    for (const message of batch.outputs.rx) context.topics.publish('rx', message.value.slice());
  },
  dispose() {},
});

export default create;
