export default function imageViewer(api) {
  const SLOTS = 3;
  /** Slot index the viewer shows; the `select` port and the property agree on it. */
  let index = clampSlot(Number(api.props.index) || 0);
  /** `src -> { bitmap, failed }`; a slot reloads only when its `src` changes. */
  const textures = new Map();

  function clampSlot(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(Math.round(value), 0), SLOTS - 1);
  }

  function sourceOf(slot) {
    const value = api.props[`image${slot}`];
    if (typeof value !== 'object' || value === null) return undefined;
    const src = value.src;
    return typeof src === 'string' && src.length > 0 ? src : undefined;
  }

  function texture(src) {
    const cached = textures.get(src);
    if (cached !== undefined) return cached;
    const entry = { bitmap: undefined, failed: false };
    textures.set(src, entry);
    api.assets
      .loadImage(src)
      .then((bitmap) => {
        entry.bitmap = bitmap;
        api.invalidate();
      })
      .catch(() => {
        entry.failed = true;
        api.invalidate();
      });
    return entry;
  }

  function current() {
    const src = sourceOf(index);
    return src === undefined ? undefined : texture(src);
  }

  function box() {
    const pad = Math.max(4, Math.min(api.width, api.height) * 0.04);
    return {
      x: pad,
      y: pad,
      width: Math.max(0, api.width - pad * 2),
      height: Math.max(0, api.height - pad * 2),
    };
  }

  // The MCU chooses the picture through the `select` port.
  api.subscribe('select', (payload) => {
    const next = clampSlot(Number(payload));
    if (next === index) return;
    index = next;
    api.invalidate();
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;
      context.clearRect(0, 0, width, height);
      context.fillStyle =
        typeof api.props.background === 'string' ? api.props.background : '#09090B';
      context.fillRect(0, 0, width, height);

      const area = box();
      const entry = current();
      if (entry !== undefined && entry.bitmap !== undefined) {
        const bitmap = entry.bitmap;
        const mode = Number(api.props.mode) === 1 ? 'cover' : 'contain';
        const scale =
          mode === 'cover'
            ? Math.max(area.width / bitmap.width, area.height / bitmap.height)
            : Math.min(area.width / bitmap.width, area.height / bitmap.height);
        const drawWidth = bitmap.width * scale;
        const drawHeight = bitmap.height * scale;
        context.save();
        context.beginPath();
        context.rect(area.x, area.y, area.width, area.height);
        context.clip();
        context.drawImage(
          bitmap,
          area.x + (area.width - drawWidth) / 2,
          area.y + (area.height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        context.restore();
      } else {
        context.fillStyle = 'rgba(244, 244, 245, 0.72)';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        const size = Math.max(9, Math.min(height * 0.12, width * 0.1));
        context.font = `500 ${size}px system-ui, sans-serif`;
        const message =
          entry === undefined ? '未选择图片' : entry.failed ? '图片加载失败' : '正在解码…';
        context.fillText(message, width / 2, height / 2);
      }

      // Slot badge, so a reader can see which image the MCU selected.
      const label = `#${index + 1}`;
      context.fillStyle = 'rgba(9, 9, 11, 0.72)';
      const badge = Math.max(16, Math.min(width, height) * 0.14);
      context.fillRect(area.x, area.y, badge, badge);
      context.fillStyle = '#F4F4F5';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `600 ${Math.max(9, badge * 0.5)}px ui-monospace, monospace`;
      context.fillText(label, area.x + badge / 2, area.y + badge / 2);
    },

    input(event) {
      if (event.type !== 'pointerdown') return;
      // Clicking cycles the slots, which is the same action as the MCU's `select`.
      index = (index + 1) % SLOTS;
      api.invalidate();
      api.publish('selected', index, 0);
    },

    /**
     * Reloads whichever slot changed.
     *
     * `assets.loadImage` returns a fresh bitmap each time, so the previous one
     * for that `src` is closed before the cache entry is replaced.
     */
    onPropsChanged(props) {
      const wanted = clampSlot(Number(props.index) || 0);
      if (wanted !== index) {
        index = wanted;
      }
      const live = new Set();
      for (let slot = 0; slot < SLOTS; slot += 1) {
        const value = props[`image${slot}`];
        if (typeof value === 'object' && value !== null && typeof value.src === 'string') {
          live.add(value.src);
        }
      }
      for (const [src, entry] of textures) {
        if (live.has(src)) continue;
        if (entry.bitmap !== undefined) entry.bitmap.close();
        textures.delete(src);
      }
      api.invalidate();
    },

    dispose() {
      for (const entry of textures.values()) {
        if (entry.bitmap !== undefined) entry.bitmap.close();
      }
      textures.clear();
    },
  };
}
