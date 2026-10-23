/* global Blob, createImageBitmap */

/** MIME hint for the `Blob`; the decoder still sniffs the bytes. */
function imageType(src) {
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

export default function backgroundImage(api) {
  const property = api.props.image;
  const src = property && typeof property === 'object' ? property.src : undefined;
  let bitmap;
  let failed = false;

  async function load() {
    try {
      if (typeof src !== 'string') {
        throw new TypeError('image.src must be a string');
      }
      const bytes = await api.assets.readBinary(src);
      bitmap = await createImageBitmap(new Blob([bytes], { type: imageType(src) }));
    } catch {
      failed = true;
    } finally {
      // The first frame is painted before the bytes arrive, so a repaint is owed either way.
      api.invalidate();
    }
  }

  void load();

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (bitmap) {
        // Contain: keep the aspect ratio and center what does not fit.
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
        return;
      }

      context.fillStyle = failed ? 'rgba(248, 113, 113, 0.16)' : 'rgba(148, 163, 184, 0.16)';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#e5e5e5';
      context.font = `500 ${Math.max(10, Math.min(width, height) * 0.08)}px system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(failed ? '图片不可用' : '正在加载…', width / 2, height / 2);
    },
    dispose() {
      if (bitmap) {
        bitmap.close();
      }
    },
  };
}
