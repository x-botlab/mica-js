import type {
  WidgetTextInputNativeEvent,
  WidgetTextSelectionNativeEvent,
} from '../runtime/protocol';

/** Anything the host may forward from the native control to the guest. */
export type WidgetTextInputPostEvent = WidgetTextInputNativeEvent | WidgetTextSelectionNativeEvent;

/** Which native control backs a session. */
export type WidgetTextInputProxyKind = 'input' | 'selection';

/** Initial state of a proxy; the host maps one `begin` command onto it. */
export interface WidgetTextInputBeginOptions {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Full text the session starts with. */
  readonly text: string;
  /** Caret offset for `input`, selection start for `selection`. */
  readonly start: number;
  /** Selection end for `selection`; equal to `start` for `input`. */
  readonly end: number;
}

/**
 * Host-side native control the widget runtime drives. Implementations are injected through
 * `WidgetHostOptions.textInputProxy`, so the host stays testable without a DOM.
 */
export interface WidgetTextInputProxy {
  begin(options: WidgetTextInputBeginOptions): void;
  /** Moves the control (input sessions). */
  update(position: { readonly x: number; readonly y: number }): void;
  /** Applies a widget-driven range (selection sessions). */
  updateRange(range: { readonly start: number; readonly end: number }): void;
  /** Ends with the current value; posts a `commit` event to the guest. */
  commit(): void;
  /** Ends without a value; posts a `cancel` event to the guest. */
  cancel(): void;
  /** Removes the control and stops posting, without emitting an end event. */
  dispose(): void;
}

export interface WidgetTextInputProxyContext {
  readonly instanceId: string;
  readonly kind: WidgetTextInputProxyKind;
  /** Forwards one native event to the guest. */
  readonly post: (event: WidgetTextInputPostEvent) => void;
}

/** Creates the overlay for one session; returning `undefined` reports the session as failed. */
export type WidgetTextInputProxyFactory = (
  context: WidgetTextInputProxyContext,
) => WidgetTextInputProxy | undefined;

/**
 * Style properties the proxy writes. Declared narrowly so a fake textarea only implements what the
 * proxy actually touches; the DOM `CSSStyleDeclaration` satisfies it structurally.
 */
export interface TextInputProxyStyle {
  position: string;
  left: string;
  top: string;
  width: string;
  height: string;
  margin: string;
  padding: string;
  border: string;
  outline: string;
  background: string;
  color: string;
  caretColor: string;
  opacity: string;
  pointerEvents: string;
  resize: string;
  overflow: string;
  whiteSpace: string;
  fontSize: string;
  lineHeight: string;
  fontFamily: string;
  zIndex: string;
}

/** Minimal `<textarea>` surface the proxy drives. */
export interface TextInputProxyElement {
  value: string;
  readonly style: TextInputProxyStyle;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
  blur(): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  remove(): void;
}

/** Minimal document surface; `document` itself is passed through with a narrow cast. */
export interface TextInputProxyDocument {
  createElement(tagName: 'textarea'): TextInputProxyElement;
  body: { appendChild(element: TextInputProxyElement): void } | null;
  /** Optional so a minimal fake needs nothing more; real selections change on the document. */
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** Positioning anchor; defaults to the document body. */
export interface TextInputProxyAnchor {
  getBoundingClientRect(): { readonly left: number; readonly top: number };
}

export interface TextInputProxyOptions {
  readonly kind: WidgetTextInputProxyKind;
  readonly document: TextInputProxyDocument;
  /** Element the logical `(x, y)` is relative to. Defaults to the viewport origin. */
  readonly anchor?: TextInputProxyAnchor;
  /** CSS pixels per logical widget unit. Defaults to `1`. */
  readonly scale?: number;
  /** Receives native events routed back to the guest. */
  readonly post: (event: WidgetTextInputPostEvent) => void;
}

interface TextControlEvent {
  readonly data?: string;
  readonly isComposing?: boolean;
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly preventDefault?: () => void;
}

/**
 * Hidden native control that gives a canvas widget real IME and selection support.
 *
 * The control is a `<textarea>` because that is the element every browser routes composition
 * events through. It is transparent and non-interactive for pointer input (the widget keeps
 * receiving those); only focus, composition and keyboard events matter here. The textarea receives
 * events the browser fires for the real control, and each one is posted to the guest, which owns
 * the widget-facing state machine.
 */
export class TextInputProxy implements WidgetTextInputProxy {
  readonly #kind: WidgetTextInputProxyKind;
  readonly #document: TextInputProxyDocument;
  readonly #anchor: TextInputProxyAnchor | undefined;
  readonly #scale: number;
  readonly #post: (event: WidgetTextInputPostEvent) => void;
  readonly #element: TextInputProxyElement;
  #active = false;
  #composing = false;
  /** Range last posted, so focusing the control does not echo the range the widget just set. */
  #notifiedStart = -1;
  #notifiedEnd = -1;

  constructor(options: TextInputProxyOptions) {
    this.#kind = options.kind;
    this.#document = options.document;
    this.#anchor = options.anchor;
    this.#scale =
      typeof options.scale === 'number' && Number.isFinite(options.scale) && options.scale > 0
        ? options.scale
        : 1;
    this.#post = options.post;

    const element = options.document.createElement('textarea');
    const style = element.style;
    style.position = 'fixed';
    style.left = '0px';
    style.top = '0px';
    style.width = '0px';
    style.height = '0px';
    style.margin = '0';
    style.padding = '0';
    style.border = '0';
    style.outline = '0';
    style.background = 'transparent';
    style.color = 'transparent';
    style.caretColor = 'transparent';
    style.opacity = '0';
    style.pointerEvents = 'none';
    style.resize = 'none';
    style.overflow = 'hidden';
    style.whiteSpace = 'pre';
    // 16px keeps mobile browsers from zooming into the invisible field.
    style.fontSize = '16px';
    style.lineHeight = '1';
    style.fontFamily = 'sans-serif';
    style.zIndex = '2147483647';
    this.#element = element;

    if (this.#kind === 'input') {
      element.addEventListener('compositionstart', this.#onCompositionStart);
      element.addEventListener('compositionupdate', this.#onCompositionUpdate);
      element.addEventListener('compositionend', this.#onCompositionEnd);
      element.addEventListener('input', this.#onInput);
    } else {
      // `select` covers handle drags; keyboard and pointer movement need their own events, and
      // `selectionchange` catches the platforms that only report form-control selection there.
      element.addEventListener('select', this.#onSelectionChange);
      element.addEventListener('keyup', this.#onSelectionChange);
      element.addEventListener('pointerup', this.#onSelectionChange);
      element.addEventListener('input', this.#onSelectionChange);
      this.#document.addEventListener?.('selectionchange', this.#onDocumentSelectionChange);
    }
    element.addEventListener('keydown', this.#onKeyDown);
    element.addEventListener('blur', this.#onBlur);

    this.#document.body?.appendChild(element);
  }

  /** True while the control is focused and still reports events. */
  get active(): boolean {
    return this.#active;
  }

  begin(options: WidgetTextInputBeginOptions): void {
    this.#active = true;
    this.#composing = false;
    this.#element.value = options.text;
    const range = this.#range(options.start, options.end);
    this.#notifiedStart = range.start;
    this.#notifiedEnd = range.end;
    this.#place(options.x, options.y, options.width, options.height);
    this.#element.setSelectionRange(range.start, range.end);
    this.#element.focus();
  }

  update(position: { readonly x: number; readonly y: number }): void {
    if (!this.#active) return;
    const width = Number.parseFloat(this.#element.style.width);
    const height = Number.parseFloat(this.#element.style.height);
    this.#place(position.x, position.y, width / this.#scale, height / this.#scale);
  }

  updateRange(range: { readonly start: number; readonly end: number }): void {
    if (!this.#active || this.#kind !== 'selection') return;
    const clamped = this.#range(range.start, range.end);
    this.#notifiedStart = clamped.start;
    this.#notifiedEnd = clamped.end;
    this.#element.setSelectionRange(clamped.start, clamped.end);
  }

  commit(): void {
    if (!this.#active) return;
    this.#active = false;
    const event = this.#currentEndEvent('commit');
    this.#element.blur();
    this.#post(event);
  }

  cancel(): void {
    if (!this.#active) return;
    this.#active = false;
    const event = this.#currentEndEvent('cancel');
    this.#element.blur();
    this.#post(event);
  }

  dispose(): void {
    this.#active = false;
    const element = this.#element;
    if (this.#kind === 'input') {
      element.removeEventListener('compositionstart', this.#onCompositionStart);
      element.removeEventListener('compositionupdate', this.#onCompositionUpdate);
      element.removeEventListener('compositionend', this.#onCompositionEnd);
      element.removeEventListener('input', this.#onInput);
    } else {
      element.removeEventListener('select', this.#onSelectionChange);
      element.removeEventListener('keyup', this.#onSelectionChange);
      element.removeEventListener('pointerup', this.#onSelectionChange);
      element.removeEventListener('input', this.#onSelectionChange);
      this.#document.removeEventListener?.('selectionchange', this.#onDocumentSelectionChange);
    }
    element.removeEventListener('keydown', this.#onKeyDown);
    element.removeEventListener('blur', this.#onBlur);
    element.remove();
  }

  #place(x: number, y: number, width: number, height: number): void {
    const rect = this.#anchor?.getBoundingClientRect();
    const scale = this.#scale;
    const left = (rect?.left ?? 0) + finite(x) * scale;
    const top = (rect?.top ?? 0) + finite(y) * scale;
    const style = this.#element.style;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${Math.max(1, finite(width, 1) * scale)}px`;
    style.height = `${Math.max(1, finite(height, 1) * scale)}px`;
  }

  #caret(length: number): number {
    const start = this.#element.selectionStart;
    if (typeof start !== 'number' || !Number.isFinite(start)) return length;
    return Math.min(Math.max(Math.trunc(start), 0), length);
  }

  /** Clamps a range to the control value and orders it, whatever the caller supplied. */
  #range(start: number, end: number): { readonly start: number; readonly end: number } {
    const length = this.#element.value.length;
    const first = clampOffset(start, length);
    const second = clampOffset(end, length);
    return first <= second ? { start: first, end: second } : { start: second, end: first };
  }

  #currentEndEvent(type: 'commit' | 'cancel'): WidgetTextInputPostEvent {
    const value = this.#element.value;
    if (this.#kind === 'input') {
      return { type, text: value, cursorPosition: this.#caret(value.length) };
    }
    const { start, end } = this.#range(
      this.#notifiedStart < 0 ? 0 : this.#notifiedStart,
      this.#notifiedEnd < 0 ? 0 : this.#notifiedEnd,
    );
    return { type, start, end, selectedText: value.slice(start, end) };
  }

  #postComposition(
    type: 'compositionstart' | 'compositionupdate' | 'compositionend',
    text: string,
  ): void {
    if (!this.#active) return;
    // The guest mirrors the composition string itself, so the caret sits at its end. The native
    // selection only covers the committed value, not the IME's pending text.
    this.#post({ type, text, cursorPosition: text.length });
  }

  #onCompositionStart = (event: TextControlEvent): void => {
    this.#composing = true;
    this.#postComposition('compositionstart', event.data ?? '');
  };

  #onCompositionUpdate = (event: TextControlEvent): void => {
    this.#postComposition('compositionupdate', event.data ?? '');
  };

  #onCompositionEnd = (event: TextControlEvent): void => {
    this.#composing = false;
    this.#postComposition('compositionend', event.data ?? this.#element.value);
  };

  #onInput = (): void => {
    if (!this.#active) return;
    const value = this.#element.value;
    this.#post({ type: 'input', text: value, cursorPosition: this.#caret(value.length) });
  };

  #onSelectionChange = (): void => {
    if (!this.#active || this.#kind !== 'selection') return;
    const value = this.#element.value;
    const start = this.#caret(value.length);
    const rawEnd = this.#element.selectionEnd;
    const range = this.#range(start, typeof rawEnd === 'number' ? rawEnd : start);
    if (range.start === this.#notifiedStart && range.end === this.#notifiedEnd) return;
    this.#notifiedStart = range.start;
    this.#notifiedEnd = range.end;
    this.#post({
      type: 'change',
      start: range.start,
      end: range.end,
      selectedText: value.slice(range.start, range.end),
    });
  };

  /** Document-level `selectionchange` fires with no usable event; the element holds the range. */
  #onDocumentSelectionChange = (): void => {
    this.#onSelectionChange();
  };

  #onKeyDown = (event: TextControlEvent): void => {
    if (!this.#active) return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      this.cancel();
      return;
    }
    if (event.key !== 'Enter') return;
    // Enter during IME composition belongs to the candidate window, not to the widget.
    if (this.#composing || event.isComposing) return;
    event.preventDefault?.();
    this.commit();
  };

  #onBlur = (): void => {
    // `commit` / `cancel` clear the flag before blurring, so only a user-driven blur commits.
    if (!this.#active) return;
    this.commit();
  };
}

/** Options for {@link createTextInputProxy}. */
export interface CreateTextInputProxyOptions {
  readonly kind: WidgetTextInputProxyKind;
  readonly post: (event: WidgetTextInputPostEvent) => void;
  /** Positions the overlay; defaults to `document.body`. */
  readonly anchor?: HTMLElement;
  /** CSS pixels per logical widget unit. Defaults to `1`. */
  readonly scale?: number;
}

/**
 * Creates the default `<textarea>` overlay.
 *
 * Returns `undefined` when there is no DOM (Node, workers) or the document has no body yet. The
 * widget host turns that into a `widget/text-input-failed` diagnostic instead of throwing, so a
 * canvas stays usable in a headless environment.
 */
export function createTextInputProxy(
  options: CreateTextInputProxyOptions,
): WidgetTextInputProxy | undefined {
  if (typeof document === 'undefined') return undefined;
  const body = document.body;
  if (body === null) return undefined;

  return new TextInputProxy({
    kind: options.kind,
    post: options.post,
    document: document as unknown as TextInputProxyDocument,
    anchor: (options.anchor ?? body) as unknown as TextInputProxyAnchor,
    ...(options.scale === undefined ? {} : { scale: options.scale }),
  });
}

function finite(value: number, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampOffset(value: number, length: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), length);
}
