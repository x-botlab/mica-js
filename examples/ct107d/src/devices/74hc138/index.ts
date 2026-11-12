import type { Factory } from './model.ddl';

const PORTS = ['select', 'enabled'] as const;

/**
 * 把译码端口转发到同名话题；输出通道用于批次内观察，话题用于 UI 绑定。
 *
 * `code` 是 bytes 端口：运行时把通道值包装成只读 `ReadonlyBytes` 代理，而话题契约只接受
 * `Uint8Array`，因此发布前用 `slice()` 复制一份真实字节数组。
 */
const create: Factory = (context) => ({
  sync(batch) {
    for (const name of PORTS) {
      const messages = batch.outputs[name];
      const latest = messages[messages.length - 1];

      if (latest !== undefined) context.topics.publish(name, latest.value);
    }

    const messages = batch.outputs.code;
    const latest = messages[messages.length - 1];

    if (latest !== undefined) context.topics.publish('code', latest.value.slice());
  },
  dispose() {},
});

export default create;
