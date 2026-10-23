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

/** `src` of an image property that actually points somewhere; `undefined` means "no image". */
function imageSource(value) {
  if (typeof value !== 'object' || value === null) return undefined;
  const src = value.src;
  return typeof src === 'string' && src.length > 0 ? src : undefined;
}

function colorOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function roundedPath(context, width, height, radius) {
  context.beginPath();
  if (radius <= 0) {
    context.rect(0, 0, width, height);
    return;
  }
  if (typeof context.roundRect === 'function') {
    context.roundRect(0, 0, width, height, radius);
    return;
  }
  context.moveTo(radius, 0);
  context.lineTo(width - radius, 0);
  context.arcTo(width, 0, width, radius, radius);
  context.lineTo(width, height - radius);
  context.arcTo(width, height, width - radius, height, radius);
  context.lineTo(radius, height);
  context.arcTo(0, height, 0, height - radius, radius);
  context.lineTo(0, radius);
  context.arcTo(0, 0, radius, 0, radius);
  context.closePath();
}

/** Cover: fill the box and crop the overflow, so a photo keeps its aspect ratio. */
function drawCover(context, bitmap, width, height) {
  const scale = Math.max(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  context.drawImage(
    bitmap,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

export default function pushButton(api) {
  let pressed = false;
  /** `src` → texture record, filled once the prefetched bytes decode. */
  const textures = new Map();

  function texture(src) {
    const cached = textures.get(src);
    if (cached !== undefined) return cached;
    const entry = { bitmap: undefined };
    textures.set(src, entry);
    api.assets
      .readBinary(src)
      .then((bytes) => createImageBitmap(new Blob([bytes], { type: imageType(src) })))
      .then((bitmap) => {
        entry.bitmap = bitmap;
        api.invalidate();
      })
      .catch(() => {
        // A missing or undecodable image leaves the background colour in charge.
      });
    return entry;
  }

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;

      const radius = Math.min(
        Math.max(Number(api.props.radius) || 0, 0),
        Math.min(width, height) / 2,
      );
      // An image wins over the colour; the colour stays as the fallback while it decodes.
      const source = imageSource(pressed ? api.props.imagePressed : api.props.image);
      const background = colorOf(pressed ? api.props.backgroundPressed : api.props.background);
      const texture_ = source === undefined ? undefined : texture(source);

      context.save();
      roundedPath(context, width, height, radius);
      if (texture_ !== undefined && texture_.bitmap !== undefined) {
        context.clip();
        drawCover(context, texture_.bitmap, width, height);
      } else if (background !== undefined) {
        context.fillStyle = background;
        context.fill();
      }
      context.restore();

      const label =
        api.props.label === undefined || api.props.label === null ? '' : String(api.props.label);
      if (label.length === 0) return;

      let size = Math.max(7, Math.min(height * 0.4, width * 0.4));
      context.font = `600 ${size}px system-ui, sans-serif`;
      const limit = width * 0.86;
      const measured = context.measureText(label).width;
      if (measured > limit) {
        size = Math.max(6, (size * limit) / measured);
        context.font = `600 ${size}px system-ui, sans-serif`;
      }

      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = pressed ? '#ffffff' : '#f4f4f5';
      // Keeps the text readable over a photo, where a flat fill alone would disappear.
      context.shadowColor = 'rgba(0, 0, 0, 0.55)';
      context.shadowBlur = Math.max(2, size * 0.3);
      context.fillText(label, width / 2, height / 2 + (pressed ? 1 : 0));
      context.shadowBlur = 0;
      context.shadowColor = 'transparent';
    },
    input(event) {
      if (event.type === 'pointerdown') {
        pressed = true;
        api.invalidate();
        api.publish('press', true, 0);
        return;
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        pressed = false;
        api.invalidate();
        api.publish('press', false, 0);
      }
    },
    dispose() {
      for (const entry of textures.values()) {
        if (entry.bitmap !== undefined) entry.bitmap.close();
      }
      textures.clear();
    },
  };
}
