import type { WidgetFactory } from '@mica-js/sdk/widget';
import { beginFrame, centeredText } from '../drawing.js';

/**
 * 背景图：把 `image` 属性指向的位图按比例铺开，作为其他 widget 的对位基准。
 *
 * 画布把实例矩形当作图片的逻辑尺寸使用——本工程的 CT107D 画布把实例放在 (0, 0)、
 * 大小 1068×768，正好等于照片的像素尺寸，因此按钮/数码管的坐标可以直接取照片像素。
 */

/** `Blob` 的 MIME 提示；解码仍由 `createImageBitmap` 按内容判断。 */
function imageType(src: string): string {
  const extension = (/\.([a-z0-9]+)$/i.exec(src)?.[1] ?? '').toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    default:
      return '';
  }
}

const create: WidgetFactory = (api) => {
  const property = api.props.image;
  const src =
    typeof property === 'object' && property !== null && 'src' in property
      ? (property as { src?: unknown }).src
      : undefined;
  let bitmap: ImageBitmap | undefined;
  let failed = false;

  async function load(): Promise<void> {
    try {
      if (typeof src !== 'string' || src.length === 0) {
        throw new TypeError('image.src must be a non-empty string');
      }
      const bytes = await api.assets.readBinary(src);
      // 复制到独立的 ArrayBuffer：Blob 不接受可能来自 SharedArrayBuffer 的视图。
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      bitmap = await createImageBitmap(new Blob([copy.buffer], { type: imageType(src) }));
    } catch {
      failed = true;
    } finally {
      // 第一帧在字节到达前就已画出，因此无论成功失败都要重绘一次。
      api.invalidate();
    }
  }

  void load();

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (!beginFrame(context, width, height)) return;

      if (bitmap !== undefined) {
        // contain：保持比例，居中留白；实例矩形与照片同比例时正好铺满。
        const scale = Math.min(width / bitmap.width, height / bitmap.height);
        const drawWidth = bitmap.width * scale;
        const drawHeight = bitmap.height * scale;
        context.drawImage(
          bitmap,
          (width - drawWidth) / 2,
          (height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        context.restore();
        return;
      }

      context.fillStyle = failed ? 'rgba(248, 113, 113, 0.18)' : 'rgba(148, 163, 184, 0.18)';
      context.fillRect(0, 0, width, height);
      centeredText(
        context,
        failed ? '图片不可用' : '正在加载…',
        width / 2,
        height / 2,
        Math.min(width, height) * 0.08,
        '#e5e7eb',
        width,
      );
      context.restore();
    },
    dispose() {
      if (bitmap !== undefined) bitmap.close();
    },
  };
};

export default create;
