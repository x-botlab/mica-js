import type { Factory } from './model.ddl';

/**
 * 把 256 字节存储映像转发到同名话题。
 *
 * 运行时把通道值包装成只读 `ReadonlyBytes` 代理，而话题契约只接受 `Uint8Array`，因此发布
 * 前用 `slice()` 复制一份真实字节数组。
 */
const create: Factory = (context) => ({
  sync(batch) {
    const messages = batch.outputs.dump;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('dump', latest.value.slice());
  },
  dispose() {},
});

export default create;
