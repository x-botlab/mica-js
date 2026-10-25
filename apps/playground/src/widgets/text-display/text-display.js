export default function textDisplay(api) {
  const LINE_HEIGHT = 1.45;
  /** Received lines, oldest first; the tail is what fits on screen. */
  let lines = [];
  /** Text the IME is composing right now, drawn after the last line. */
  let composing = '';
  /** True while the host-side native control owns the keyboard. */
  let editing = false;
  /** Highlighted range of the line the user double-clicked, if any. */
  let selection;

  const fontSize = () => Math.max(8, Number(api.props.fontSize) || 13);
  const maxLines = () => Math.max(1, Math.round(Number(api.props.lines) || 6));
  const placeholder = () =>
    typeof api.props.placeholder === 'string' ? api.props.placeholder : '点击输入…';

  function inputRect() {
    const size = fontSize();
    const height = Math.max(18, size * 1.7);
    return {
      x: 8,
      y: Math.max(0, api.height - height - 6),
      width: Math.max(0, api.width - 16),
      height,
    };
  }

  function rowOf(index) {
    const size = fontSize();
    return 14 + index * size * LINE_HEIGHT;
  }

  function lineAt(y) {
    const size = fontSize();
    const start = size * LINE_HEIGHT * 0.2;
    const index = Math.floor((y - start) / (size * LINE_HEIGHT));
    if (!Number.isFinite(index) || index < 0) return undefined;
    const visible = visibleLines();
    return index < visible.length ? index : undefined;
  }

  function visibleLines() {
    const capacity = maxLines();
    return lines.slice(Math.max(0, lines.length - capacity));
  }

  function append(text) {
    const trimmed = String(text ?? '');
    if (trimmed.length === 0) return;
    lines.push(trimmed);
    if (lines.length > 200) lines = lines.slice(-200);
    api.invalidate();
  }

  function beginEditing() {
    if (editing) return;
    editing = true;
    const rect = inputRect();
    api.textInput.begin({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      initialText: composing,
      cursorPosition: composing.length,
    });
    api.invalidate();
  }

  // Lines arrive on the `text` port — the MCU's serial output, in the demo.
  api.subscribe('text', (payload) => {
    if (typeof payload === 'string') append(payload);
    else if (payload !== undefined && payload !== null) append(String(payload));
  });

  return {
    render(context) {
      const width = api.width;
      const height = api.height;
      if (width <= 0 || height <= 0) return;
      const size = fontSize();

      context.clearRect(0, 0, width, height);
      context.fillStyle = 'rgba(9, 9, 11, 0.9)';
      rounded(context, 0.5, 0.5, width - 1, height - 1, 8);
      context.fill();
      context.strokeStyle = editing ? 'rgba(56, 189, 248, 0.8)' : 'rgba(63, 63, 70, 0.9)';
      context.lineWidth = 1;
      context.stroke();

      const rect = inputRect();
      context.save();
      context.beginPath();
      context.rect(0, 0, width, rect.y - 2);
      context.clip();

      context.textAlign = 'left';
      context.textBaseline = 'top';
      const visible = visibleLines();
      for (const [index, line] of visible.entries()) {
        const y = rowOf(index);
        if (selection !== undefined && selection.index === index) {
          context.fillStyle = 'rgba(56, 189, 248, 0.25)';
          const x = 12 + context.measureText(line.slice(0, selection.start)).width;
          const w = context.measureText(line.slice(selection.start, selection.end)).width;
          context.fillRect(x, y - 1, Math.max(2, w), size * 1.2);
        }
        context.fillStyle = '#E4E4E7';
        context.font = `${size}px ui-monospace, SFMono-Regular, monospace`;
        context.fillText(line, 12, y);
      }

      const draftY = rowOf(visible.length);
      if (composing.length > 0) {
        context.fillStyle = '#38BDF8';
        context.font = `${size}px ui-monospace, SFMono-Regular, monospace`;
        context.fillText(composing, 12, draftY);
        context.fillRect(12, draftY + size * 1.15, context.measureText(composing).width, 1);
      } else if (visible.length === 0) {
        context.fillStyle = 'rgba(113, 113, 122, 0.85)';
        context.font = `${size}px system-ui, sans-serif`;
        context.fillText(placeholder(), 12, 14);
      }
      context.restore();

      // Input strip: the region the native control is anchored to.
      context.fillStyle = 'rgba(39, 39, 42, 0.9)';
      rounded(context, rect.x, rect.y, rect.width, rect.height, 6);
      context.fill();
      context.fillStyle = editing ? 'rgba(56, 189, 248, 0.95)' : 'rgba(113, 113, 122, 0.9)';
      context.font = `${Math.max(8, size * 0.85)}px system-ui, sans-serif`;
      context.textBaseline = 'middle';
      context.fillText(
        editing ? '输入中…（Enter 提交，Esc 取消）' : '点击这里输入',
        rect.x + 8,
        rect.y + rect.height / 2,
      );
    },

    input(event) {
      if (event.type === 'pointerdown') {
        const y = Number(event.y) || 0;
        const index = lineAt(y);
        if (index !== undefined) {
          // Double-click semantics: the pointer-down on an already selected row
          // opens a native selection over the text the widget drew itself.
          const text = visibleLines()[index];
          if (typeof text === 'string' && text.length > 0) {
            selection = { index, start: 0, end: text.length };
            api.textSelection.begin({
              text,
              start: 0,
              end: text.length,
              x: 8,
              y: rowOf(index) - 2,
              width: Math.max(10, api.width - 16),
              height: Math.max(10, fontSize() * 1.4),
            });
            api.invalidate();
            return;
          }
        }
        beginEditing();
      }
    },

    onTextInput(event) {
      if (event.type === 'composing') {
        composing = event.text;
        api.invalidate();
        return;
      }
      if (event.type === 'cancel') {
        composing = '';
        editing = false;
        api.invalidate();
        return;
      }
      // commit
      composing = '';
      editing = false;
      const text = String(event.text ?? '');
      append(text);
      if (text.length > 0) api.publish('send', text, 0);
      api.invalidate();
    },

    onTextSelection(event) {
      if (event.type === 'cancel') {
        selection = undefined;
        api.invalidate();
        return;
      }
      if (selection !== undefined) {
        selection = { index: selection.index, start: event.start, end: event.end };
        api.invalidate();
      }
      if (event.type === 'commit') {
        api.publish('selection', event.selectedText, 0);
      }
    },

    onResize() {
      if (selection !== undefined) {
        selection = undefined;
      }
      if (editing) {
        const rect = inputRect();
        api.textInput.update({ x: rect.x, y: rect.y });
      }
      api.invalidate();
    },

    dispose() {
      if (editing) {
        editing = false;
        api.textInput.cancel();
      }
      if (selection !== undefined) {
        selection = undefined;
        api.textSelection.cancel();
      }
    },
  };
}

function rounded(context, x, y, width, height, radius) {
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, Math.max(0, width), Math.max(0, height), radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
}
