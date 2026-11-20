/**
 * ILI9325 TFT 控制器的统一器件适配器。
 *
 * DDL 仍按脏矩形发送 `frameInfo` + `frameRows`；这里把同一批的行分块配对成一条完整
 * 区域更新，复制进实例自己的面板缓存后触发 `onDidFrame`。区域更新通过 transfer hook
 * 交出独立像素缓冲区，`getFramebuffer` 则返回完整 320×240 面板的只读快照，供展示
 * 在打开视图时一次性取得当前状态。
 */

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 240;
const PANEL_BYTES = PANEL_WIDTH * PANEL_HEIGHT * 2;

interface FramePayload {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export const create: DeviceFactory = (context) => {
  /** 面板坐标的 RGB565 小端字节；事件只带脏矩形，查询需要完整状态。 */
  const panel = new Uint8Array(PANEL_BYTES);

  const methods: DeviceMethods = {
    getFramebuffer: () => ({
      x: 0,
      y: 0,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      pixels: panel.slice(),
    }),
  };

  return {
    methods,
    sync(batch) {
      const infos = batch.outputs.frameInfo;
      const rows = batch.outputs.frameRows;

      if (infos.length === 0) return;

      let at = 0;

      for (const info of infos) {
        const { x, y, width, height } = info.value;
        const body = width * height * 2;
        const pixels = new Uint8Array(body);

        let filled = 0;

        while (filled < body && at < rows.length) {
          const chunk = rows[at]!.value.slice();
          const take = Math.min(chunk.length, body - filled);

          pixels.set(take === chunk.length ? chunk : chunk.subarray(0, take), filled);
          filled += take;
          at += 1;
        }

        // 分块不足说明这一批的配对已经错位：丢弃当前帧，不发布半帧。
        if (filled < body) break;

        for (let row = 0; row < height; row += 1) {
          const from = row * width * 2;
          const to = ((y + row) * PANEL_WIDTH + x) * 2;

          panel.set(pixels.subarray(from, from + width * 2), to);
        }

        const frame: FramePayload = { x, y, width, height, pixels };

        context.events.onDidFrame.fireTransferred(frame, [pixels.buffer as ArrayBuffer]);
      }
    },
    dispose() {},
  };
};
