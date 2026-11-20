type Batch = Parameters<ReturnType<DeviceFactory>['sync']>[0];

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 240;

function emptyPanel(): Uint8Array {
  const frame = new Uint8Array(8 + PANEL_WIDTH * PANEL_HEIGHT * 2);
  const header = new DataView(frame.buffer);
  header.setUint16(4, PANEL_WIDTH, true);
  header.setUint16(6, PANEL_HEIGHT, true);
  return frame;
}

/**
 * 把模型输出的脏矩形与行块合成公开的 RGB565 帧载荷，发出完整脏矩形事件，并在内部
 * 合成整屏快照供 `getFramebuffer` 查询。第一帧之前返回全黑 320×240 帧。
 */
export default function createLcd(context: DeviceModelContext): {
  readonly methods: { readonly getFramebuffer: () => Uint8Array };
  sync(batch: Batch): void;
  dispose(): void;
} {
  const screen = new Uint8Array(PANEL_WIDTH * PANEL_HEIGHT * 2);
  let latest = emptyPanel();

  return {
    methods: {
      getFramebuffer: () => latest,
    },
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

        for (let row = 0; row < height; row += 1) {
          const source = 8 + row * width * 2;
          const target = ((y + row) * PANEL_WIDTH + x) * 2;
          screen.set(frame.subarray(source, source + width * 2), target);
        }
        latest = new Uint8Array(8 + screen.length);
        latest.set(frame.subarray(0, 8));
        latest.set(screen, 8);
        new DataView(latest.buffer).setUint16(4, PANEL_WIDTH, true);
        new DataView(latest.buffer).setUint16(6, PANEL_HEIGHT, true);
        context.events.onDidFramebuffer.fireTransferred(frame, [frame.buffer]);
      }
    },
    dispose() {},
  };
}
