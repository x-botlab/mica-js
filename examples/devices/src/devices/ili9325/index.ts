import type { Factory } from './model.ddl';

/**
 * 把 DDL 的「帧信息 + 像素分块」重新组装成 `bytes<rgb565>` 载荷。
 *
 * DDL 侧按脏矩形复制像素体：整行覆盖或只有一行时是一条消息，其余情况每行一条。
 * 适配器只按字节总量配对，不假设分块数量；像素头为小端 `u16 x, y, width, height`。
 */
const create: Factory = (context) => ({
  sync(batch) {
    const infos = batch.outputs.frameInfo;
    const rows = batch.outputs.frameRows;

    if (infos.length === 0) return;

    let at = 0;

    for (const info of infos) {
      const { x, y, width, height } = info.value;
      const body = width * height * 2;
      const frame = new Uint8Array(8 + body);
      const header = new DataView(frame.buffer);

      header.setUint16(0, x, true);
      header.setUint16(2, y, true);
      header.setUint16(4, width, true);
      header.setUint16(6, height, true);

      let filled = 0;

      while (filled < body && at < rows.length) {
        const chunk = rows[at]!.value.slice();
        const take = Math.min(chunk.length, body - filled);

        frame.set(take === chunk.length ? chunk : chunk.subarray(0, take), 8 + filled);
        filled += take;
        at += 1;
      }

      // 分块不足说明这一批的配对已经错位：丢弃当前帧，不发布半帧。
      if (filled < body) break;
      context.topics.publish('framebuffer', frame);
    }
  },
  dispose() {},
});

export default create;
