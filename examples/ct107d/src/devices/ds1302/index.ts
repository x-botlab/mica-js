import type { Factory } from './model.ddl';

/**
 * 把走时字节与走时状态发布到同名话题；输出通道用于批次内观察，话题用于 UI 绑定。
 *
 * `datetime` 是 bytes 端口：运行时把通道值包装成只读 `ReadonlyBytes` 代理，而话题契约只
 * 接受 `Uint8Array`，因此发布前用 `slice()` 复制一份真实字节数组。
 */
const create: Factory = (context) => ({
  sync(batch) {
    const datetime = batch.outputs.datetime;
    const latestDatetime = datetime[datetime.length - 1];

    if (latestDatetime !== undefined)
      context.topics.publish('datetime', latestDatetime.value.slice());

    const running = batch.outputs.running;
    const latestRunning = running[running.length - 1];

    if (latestRunning !== undefined) context.topics.publish('running', latestRunning.value);
  },
  dispose() {},
});

export default create;
