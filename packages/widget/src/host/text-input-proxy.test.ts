import { describe, expect, it } from 'vitest';
import { TextInputProxy, createTextInputProxy } from './text-input-proxy';
import type {
  TextInputProxyDocument,
  TextInputProxyElement,
  TextInputProxyStyle,
  WidgetTextInputPostEvent,
} from './text-input-proxy';

function createStyle(): TextInputProxyStyle {
  return {
    position: '',
    left: '',
    top: '',
    width: '',
    height: '',
    margin: '',
    padding: '',
    border: '',
    outline: '',
    background: '',
    color: '',
    caretColor: '',
    opacity: '',
    pointerEvents: '',
    resize: '',
    overflow: '',
    whiteSpace: '',
    fontSize: '',
    lineHeight: '',
    fontFamily: '',
    zIndex: '',
  };
}

interface ControlEvent {
  readonly data?: string;
  readonly isComposing?: boolean;
  readonly key?: string;
  readonly preventDefault?: () => void;
}

class FakeTextArea implements TextInputProxyElement {
  value = '';
  readonly style = createStyle();
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  focused = false;
  removed = false;
  readonly #listeners = new Map<string, Set<(event: never) => void>>();

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  focus(): void {
    this.focused = true;
  }

  blur(): void {
    const wasFocused = this.focused;
    this.focused = false;
    if (wasFocused) this.dispatch('blur', {});
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  remove(): void {
    this.removed = true;
  }

  dispatch(type: string, event: ControlEvent = {}): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event as never);
    }
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

interface FakeDocument extends TextInputProxyDocument {
  readonly textarea: FakeTextArea;
  readonly appended: TextInputProxyElement[];
  readonly documentListenerCount: number;
  dispatchDocument(type: string): void;
}

function createFakeDocument(): FakeDocument {
  const textarea = new FakeTextArea();
  const appended: TextInputProxyElement[] = [];
  const documentListeners = new Set<() => void>();
  return {
    textarea,
    appended,
    createElement: () => textarea,
    body: {
      appendChild: (element: TextInputProxyElement) => {
        appended.push(element);
      },
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'selectionchange') documentListeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'selectionchange') documentListeners.delete(listener);
    },
    dispatchDocument: (type: string) => {
      if (type !== 'selectionchange') return;
      for (const listener of [...documentListeners]) listener();
    },
    get documentListenerCount() {
      return documentListeners.size;
    },
  };
}

const anchor = { getBoundingClientRect: () => ({ left: 100, top: 50 }) };

function createInputProxy(scale = 1) {
  const document = createFakeDocument();
  const events: WidgetTextInputPostEvent[] = [];
  const proxy = new TextInputProxy({
    kind: 'input',
    document,
    anchor,
    scale,
    post: (event) => events.push(event),
  });
  return { proxy, document, textarea: document.textarea, events };
}

function createSelectionProxy() {
  const document = createFakeDocument();
  const events: WidgetTextInputPostEvent[] = [];
  const proxy = new TextInputProxy({
    kind: 'selection',
    document,
    anchor,
    post: (event) => events.push(event),
  });
  return { proxy, document, textarea: document.textarea, events };
}

describe('TextInputProxy', () => {
  it('positions the native control against the anchor and focuses it', () => {
    const { proxy, textarea, document } = createInputProxy(2);

    proxy.begin({ x: 5, y: 6, width: 30, height: 12, text: 'hi', start: 2, end: 2 });

    expect(textarea.style.position).toBe('fixed');
    expect(textarea.style.left).toBe('110px');
    expect(textarea.style.top).toBe('62px');
    expect(textarea.style.width).toBe('60px');
    expect(textarea.style.height).toBe('24px');
    expect(textarea.style.opacity).toBe('0');
    expect(textarea.value).toBe('hi');
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
    expect(textarea.focused).toBe(true);
    expect(document.appended).toEqual([textarea]);
    expect(proxy.active).toBe(true);
  });

  it('moves the control without changing its size', () => {
    const { proxy, textarea } = createInputProxy();
    proxy.begin({ x: 1, y: 2, width: 30, height: 12, text: '', start: 0, end: 0 });

    proxy.update({ x: 20, y: 30 });

    expect(textarea.style.left).toBe('120px');
    expect(textarea.style.top).toBe('80px');
    expect(textarea.style.width).toBe('30px');
    expect(textarea.style.height).toBe('12px');
  });

  it('forwards composition events with the IME data', () => {
    const { proxy, textarea, events } = createInputProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: '', start: 0, end: 0 });

    textarea.dispatch('compositionstart', { data: '' });
    textarea.dispatch('compositionupdate', { data: 'nihao' });
    textarea.dispatch('compositionupdate', { data: '你好' });
    textarea.dispatch('compositionend', { data: '你好' });

    expect(events).toEqual([
      { type: 'compositionstart', text: '', cursorPosition: 0 },
      { type: 'compositionupdate', text: 'nihao', cursorPosition: 5 },
      { type: 'compositionupdate', text: '你好', cursorPosition: 2 },
      { type: 'compositionend', text: '你好', cursorPosition: 2 },
    ]);
  });

  it('forwards the full value and caret on input', () => {
    const { proxy, textarea, events } = createInputProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: '', start: 0, end: 0 });

    textarea.value = 'hallo';
    textarea.selectionStart = 3;
    textarea.selectionEnd = 3;
    textarea.dispatch('input');

    expect(events).toEqual([{ type: 'input', text: 'hallo', cursorPosition: 3 }]);
  });

  it('commits on Enter and suppresses the newline', () => {
    const { proxy, textarea, events } = createInputProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'done', start: 4, end: 4 });
    let prevented = 0;

    textarea.dispatch('keydown', { key: 'Enter', preventDefault: () => (prevented += 1) });

    expect(prevented).toBe(1);
    expect(proxy.active).toBe(false);
    expect(events).toEqual([{ type: 'commit', text: 'done', cursorPosition: 4 }]);
  });

  it('does not commit on Enter while the IME is composing', () => {
    const { proxy, textarea, events } = createInputProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: '', start: 0, end: 0 });
    let prevented = 0;

    textarea.dispatch('compositionstart', { data: 'に' });
    textarea.dispatch('keydown', { key: 'Enter', preventDefault: () => (prevented += 1) });

    expect(prevented).toBe(0);
    expect(proxy.active).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['compositionstart']);
  });

  it('commits when the native control loses focus', () => {
    const { proxy, textarea, events } = createInputProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'blurred', start: 7, end: 7 });

    textarea.blur();

    expect(proxy.active).toBe(false);
    expect(events).toEqual([{ type: 'commit', text: 'blurred', cursorPosition: 7 }]);
  });

  it('cancels on Escape', () => {
    const { proxy, textarea, events } = createInputProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'draft', start: 5, end: 5 });

    textarea.dispatch('keydown', { key: 'Escape' });

    expect(proxy.active).toBe(false);
    expect(events).toEqual([{ type: 'cancel', text: 'draft', cursorPosition: 5 }]);
  });

  it('stops reporting native events after commit', () => {
    const { proxy, textarea, events } = createInputProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'a', start: 1, end: 1 });
    textarea.value = 'ab';

    proxy.commit();
    textarea.dispatch('input');
    textarea.dispatch('compositionupdate', { data: 'x' });
    textarea.blur();

    expect(events).toEqual([{ type: 'commit', text: 'ab', cursorPosition: 1 }]);
  });

  it('reports native selection changes once per range', () => {
    const { proxy, textarea, document, events } = createSelectionProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'Hello World', start: 0, end: 5 });

    textarea.selectionStart = 6;
    textarea.selectionEnd = 11;
    textarea.dispatch('select');
    // The same range again (document-level echo) must not reach the guest twice.
    document.dispatchDocument('selectionchange');

    expect(events).toEqual([{ type: 'change', start: 6, end: 11, selectedText: 'World' }]);
  });

  it('reads the range from the control on a document selection change', () => {
    const { proxy, textarea, document, events } = createSelectionProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'Hello World', start: 0, end: 0 });

    textarea.selectionStart = 0;
    textarea.selectionEnd = 5;
    document.dispatchDocument('selectionchange');

    expect(events).toEqual([{ type: 'change', start: 0, end: 5, selectedText: 'Hello' }]);
  });

  it('reports a collapsed caret moved with the keyboard', () => {
    const { proxy, textarea, events } = createSelectionProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'Hello World', start: 0, end: 5 });

    textarea.selectionStart = 7;
    textarea.selectionEnd = 7;
    textarea.dispatch('keyup', { key: 'ArrowRight' });

    expect(events).toEqual([{ type: 'change', start: 7, end: 7, selectedText: '' }]);
  });

  it('applies a widget-driven range without echoing it', () => {
    const { proxy, textarea, events } = createSelectionProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'Hello World', start: 0, end: 0 });

    proxy.updateRange({ start: 6, end: 11 });
    textarea.dispatch('select');

    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(11);
    expect(events).toEqual([]);
  });

  it('commits a selection with the last range', () => {
    const { proxy, textarea, events } = createSelectionProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'Hello World', start: 6, end: 11 });

    textarea.dispatch('keydown', { key: 'Enter' });

    expect(proxy.active).toBe(false);
    expect(events).toEqual([{ type: 'commit', start: 6, end: 11, selectedText: 'World' }]);
  });

  it('cancels a selection on Escape', () => {
    const { proxy, textarea, events } = createSelectionProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'Hello', start: 1, end: 4 });

    textarea.dispatch('keydown', { key: 'Escape' });

    expect(events).toEqual([{ type: 'cancel', start: 1, end: 4, selectedText: 'ell' }]);
  });

  it('removes the control and every listener on dispose', () => {
    const { proxy, textarea, document, events } = createSelectionProxy();
    proxy.begin({ x: 0, y: 0, width: 20, height: 10, text: 'abc', start: 0, end: 1 });

    proxy.dispose();

    expect(textarea.removed).toBe(true);
    expect(textarea.listenerCount('select')).toBe(0);
    expect(textarea.listenerCount('keyup')).toBe(0);
    expect(textarea.listenerCount('keydown')).toBe(0);
    expect(textarea.listenerCount('blur')).toBe(0);
    expect(document.documentListenerCount).toBe(0);
    textarea.dispatch('select');
    expect(events).toEqual([]);
  });

  it('returns no default control when the environment has no DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(createTextInputProxy({ kind: 'input', post: () => {} })).toBeUndefined();
  });
});
