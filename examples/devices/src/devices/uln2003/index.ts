import type { Factory } from './model.ddl';

/**
 * 把通道掩码与状态串转发到同名话题；输出通道用于批次内观察，话题用于 UI 绑定。
 *
 * `channels` 是 bytes 端口：运行时把通道值包装成只读 `ReadonlyBytes` 代理，而话题契约只
 * 接受 `Uint8Array`，因此发布前用 `slice()` 复制一份真实字节数组。
 */
const create: Factory = (context) => ({
  sync(batch) {
    const mask = batch.outputs.mask;
    const latestMask = mask[mask.length - 1];

    if (latestMask !== undefined) context.topics.publish('mask', latestMask.value);

    const channels = batch.outputs.channels;
    const latestChannels = channels[channels.length - 1];

    if (latestChannels !== undefined)
      context.topics.publish('channels', latestChannels.value.slice());
  },
  dispose() {},
});

export default create;
