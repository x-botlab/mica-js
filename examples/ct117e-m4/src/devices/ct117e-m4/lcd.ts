import type { Factory } from './model.ddl';

/** Pair the model's rectangle and row chunks into the public RGB565 topic payload. */
const create: Factory = (context) => ({
  sync(batch) {
    const infos = batch.outputs.frameInfo;
    const rows = batch.outputs.frameRows;
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
      if (filled < body) break;
      context.topics.publish('framebuffer', frame);
    }
  },
  dispose() {},
});

export default create;
