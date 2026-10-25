import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestContext } from '@mica-js/sandbox';
import type { WidgetDefinition } from '../types';
import { WIDGET_ERROR_EVENT, WIDGET_TEXT_INPUT_EVENT } from './protocol';
import type { WidgetErrorMessage, WidgetTextCommandMessage } from './protocol';
import type {
  TextInputEvent,
  TextSelectionEvent,
  WidgetInstance,
  WidgetInstanceApi,
} from './types';
import { createWidgetRuntime } from './worker-entry';
import type { WidgetRuntime } from './worker-entry';

interface CapturedEvent {
  readonly type: string;
  readonly payload: unknown;
}

class FakeCanvas {
  width: number;
  height: number;
  readonly context = { setTransform: () => {}, clearRect: () => {} };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(kind: string): unknown {
    return kind === '2d' ? this.context : null;
  }

  transferToImageBitmap(): ImageBitmap {
    return { close: () => {} } as unknown as ImageBitmap;
  }
}

type Factory = (api: WidgetInstanceApi) => WidgetInstance | void;

interface Harness {
  readonly runtime: WidgetRuntime;
  readonly api: WidgetInstanceApi;
  readonly events: CapturedEvent[];
  readonly handlers: Map<string, (...args: unknown[]) => unknown>;
}

const definition: WidgetDefinition = { properties: {}, ports: {} };

function createHarness(): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: CapturedEvent[] = [];
  let captured: WidgetInstanceApi | undefined;

  const context = {
    id: 'guest-1',
    name: 'widget-text-input-test',
    signal: new AbortController().signal,
    handle(name: string, handler: (...args: never[]) => unknown) {
      handlers.set(name, handler as unknown as (...args: unknown[]) => unknown);
    },
    invoke: async () => undefined,
    invokeWith: async () => undefined,
    on: () => () => {},
    off: () => {},
    emit(type: string, payload?: unknown) {
      events.push({ type, payload });
    },
    log: () => {},
    createSurface: () => {
      throw new Error('the widget runtime must not create surfaces');
    },
  };

  const factory: Factory = (api) => {
    captured = api;
    return {};
  };

  const runtime = createWidgetRuntime(context as unknown as GuestContext, {
    importModule: async () => ({ default: factory }),
  });

  return {
    runtime,
    get api() {
      if (!captured) throw new Error('the widget factory did not run');
      return captured;
    },
    events,
    handlers,
  };
}

async function mountWidget(): Promise<Harness> {
  const harness = createHarness();
  await harness.runtime.load({
    packages: [
      {
        id: 'demo',
        modules: { input: { definition, code: 'export default () => ({});' } },
      },
    ],
  });
  harness.runtime.mount({
    instanceId: 'a',
    widget: 'demo:input',
    width: 120,
    height: 40,
    dpr: 1,
  });
  return harness;
}

function commands(harness: Harness): WidgetTextCommandMessage[] {
  return harness.events
    .filter((event) => event.type === WIDGET_TEXT_INPUT_EVENT)
    .map((event) => event.payload as WidgetTextCommandMessage);
}

function lastCommand(harness: Harness): WidgetTextCommandMessage {
  const all = commands(harness);
  const command = all[all.length - 1];
  if (command === undefined) throw new Error('no text command was posted');
  return command;
}

function errors(harness: Harness): WidgetErrorMessage[] {
  return harness.events
    .filter((event) => event.type === WIDGET_ERROR_EVENT)
    .map((event) => event.payload as WidgetErrorMessage);
}

beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('text input session', () => {
  it('opens a native input session and posts the begin command', async () => {
    const harness = await mountWidget();
    harness.api.textInput.begin({
      x: 10,
      y: 12,
      width: 64,
      height: 24,
      initialText: '你好',
      cursorPosition: 1,
    });

    expect(lastCommand(harness)).toEqual({
      type: 'begin',
      session: 'input',
      instanceId: 'a',
      x: 10,
      y: 12,
      width: 64,
      height: 24,
      text: '你好',
      cursorPosition: 1,
    });
  });

  it('defaults the overlay size and clamps the caret', async () => {
    const harness = await mountWidget();
    harness.api.textInput.begin({ x: 0, y: 0, initialText: 'abc', cursorPosition: 99 });

    expect(lastCommand(harness)).toMatchObject({
      type: 'begin',
      session: 'input',
      width: 100,
      height: 20,
      text: 'abc',
      cursorPosition: 3,
    });
  });

  it('clamps a negative caret to the start and tolerates a missing text value', async () => {
    const harness = await mountWidget();
    harness.api.textInput.begin({ x: 0, y: 0, cursorPosition: -3 });

    expect(lastCommand(harness)).toMatchObject({ text: '', cursorPosition: 0 });
  });

  it('forwards IME composition updates as composing events', async () => {
    const harness = await mountWidget();
    const heard: TextInputEvent[] = [];
    harness.api.onTextInput((event) => heard.push(event));

    harness.api.textInput.begin({ x: 0, y: 0 });
    harness.runtime.textInput('a', {
      type: 'compositionstart',
      text: '',
      cursorPosition: 0,
    });
    harness.runtime.textInput('a', {
      type: 'compositionupdate',
      text: '你好',
      cursorPosition: 2,
    });

    expect(heard).toEqual([
      { type: 'composing', text: '', cursorPosition: 0 },
      { type: 'composing', text: '你好', cursorPosition: 2 },
    ]);
  });

  it('supports a full Chinese IME cycle followed by a host commit', async () => {
    const harness = await mountWidget();
    const heard: TextInputEvent[] = [];
    harness.api.onTextInput((event) => heard.push(event));

    harness.api.textInput.begin({ x: 0, y: 0 });
    harness.runtime.textInput('a', { type: 'compositionstart', text: '', cursorPosition: 0 });
    harness.runtime.textInput('a', {
      type: 'compositionupdate',
      text: 'nihao',
      cursorPosition: 5,
    });
    harness.runtime.textInput('a', {
      type: 'compositionupdate',
      text: '你好',
      cursorPosition: 2,
    });
    harness.runtime.textInput('a', {
      type: 'compositionend',
      text: '你好',
      cursorPosition: 2,
    });
    harness.runtime.textInput('a', { type: 'input', text: '你好', cursorPosition: 2 });
    harness.runtime.textInput('a', { type: 'commit', text: '你好', cursorPosition: 2 });

    expect(heard.map((event) => event.type)).toEqual([
      'composing',
      'composing',
      'composing',
      'composing',
      'composing',
      'commit',
    ]);
    expect(heard.at(-1)).toEqual({ type: 'commit', text: '你好', cursorPosition: 2 });
  });

  it('supports Japanese IME composition and clamps the reported caret', async () => {
    const harness = await mountWidget();
    const heard: TextInputEvent[] = [];
    harness.api.onTextInput((event) => heard.push(event));

    harness.api.textInput.begin({ x: 0, y: 0 });
    harness.runtime.textInput('a', {
      type: 'compositionupdate',
      text: 'こんにちは',
      cursorPosition: 99,
    });

    expect(heard).toEqual([{ type: 'composing', text: 'こんにちは', cursorPosition: 5 }]);
  });

  it('commits locally, asks the host to close and ignores the host echo', async () => {
    const harness = await mountWidget();
    const heard: TextInputEvent[] = [];
    harness.api.onTextInput((event) => heard.push(event));

    harness.api.textInput.begin({ x: 0, y: 0, initialText: 'hi', cursorPosition: 2 });
    harness.api.textInput.commit();

    expect(heard).toEqual([{ type: 'commit', text: 'hi', cursorPosition: 2 }]);
    expect(lastCommand(harness)).toEqual({
      type: 'commit',
      session: 'input',
      instanceId: 'a',
    });

    // The proxy acknowledges the same commit; the session is closed, so nothing is emitted twice.
    harness.runtime.textInput('a', { type: 'commit', text: 'hi', cursorPosition: 2 });
    expect(heard).toHaveLength(1);
  });

  it('cancels an active session and stops reporting composition', async () => {
    const harness = await mountWidget();
    const heard: TextInputEvent[] = [];
    harness.api.onTextInput((event) => heard.push(event));

    harness.api.textInput.begin({ x: 0, y: 0, initialText: 'abc' });
    harness.runtime.textInput('a', { type: 'compositionupdate', text: 'ab', cursorPosition: 2 });
    harness.api.textInput.cancel();
    harness.runtime.textInput('a', { type: 'compositionupdate', text: 'abcd', cursorPosition: 4 });

    expect(heard).toEqual([
      { type: 'composing', text: 'ab', cursorPosition: 2 },
      { type: 'cancel', text: 'ab', cursorPosition: 2 },
    ]);
    expect(lastCommand(harness)).toEqual({
      type: 'cancel',
      session: 'input',
      instanceId: 'a',
    });
  });

  it('moves the native control without changing the mirrored text', async () => {
    const harness = await mountWidget();
    harness.api.textInput.begin({ x: 1, y: 2 });
    harness.api.textInput.update({ x: 30, y: 40 });

    expect(lastCommand(harness)).toEqual({
      type: 'update',
      session: 'input',
      instanceId: 'a',
      x: 30,
      y: 40,
    });
  });

  it('ignores updates, commits and native events before a session starts', async () => {
    const harness = await mountWidget();
    const heard: TextInputEvent[] = [];
    harness.api.onTextInput((event) => heard.push(event));

    harness.api.textInput.update({ x: 1, y: 2 });
    harness.api.textInput.commit();
    harness.api.textInput.cancel();
    harness.runtime.textInput('a', { type: 'compositionupdate', text: 'x', cursorPosition: 1 });

    expect(commands(harness)).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('notifies every listener in registration order and honours unsubscribe', async () => {
    const harness = await mountWidget();
    const order: string[] = [];
    const first = harness.api.onTextInput(() => order.push('first'));
    harness.api.onTextInput(() => order.push('second'));

    harness.api.textInput.begin({ x: 0, y: 0 });
    harness.runtime.textInput('a', { type: 'input', text: 'a', cursorPosition: 1 });
    first();
    harness.runtime.textInput('a', { type: 'input', text: 'ab', cursorPosition: 2 });

    expect(order).toEqual(['first', 'second', 'second']);
  });

  it('contains a throwing listener and keeps the others running', async () => {
    const harness = await mountWidget();
    const received: TextInputEvent[] = [];
    harness.api.onTextInput(() => {
      throw new Error('listener exploded');
    });
    harness.api.onTextInput((event) => received.push(event));

    harness.api.textInput.begin({ x: 0, y: 0 });
    harness.runtime.textInput('a', { type: 'input', text: 'x', cursorPosition: 1 });

    expect(received).toHaveLength(1);
    expect(errors(harness)).toContainEqual({
      instanceId: 'a',
      phase: 'deliver',
      error: { name: 'Error', message: 'listener exploded' },
    });
  });

  it('cancels the host control and drops listeners when the instance unmounts', async () => {
    const harness = await mountWidget();
    const heard: TextInputEvent[] = [];
    harness.api.onTextInput((event) => heard.push(event));

    harness.api.textInput.begin({ x: 0, y: 0 });
    harness.runtime.unmount('a');

    expect(lastCommand(harness)).toEqual({
      type: 'cancel',
      session: 'input',
      instanceId: 'a',
    });
    harness.runtime.textInput('a', { type: 'input', text: 'late', cursorPosition: 4 });
    expect(heard).toEqual([]);
  });

  it('ends an active session when the runtime is disposed', async () => {
    const harness = await mountWidget();
    harness.api.textInput.begin({ x: 0, y: 0 });
    harness.runtime.dispose();

    expect(lastCommand(harness)).toEqual({
      type: 'cancel',
      session: 'input',
      instanceId: 'a',
    });
  });
});

describe('text selection session', () => {
  it('opens a selection session and reports the initial range', async () => {
    const harness = await mountWidget();
    const heard: TextSelectionEvent[] = [];
    harness.api.onTextSelection((event) => heard.push(event));

    harness.api.textSelection.begin({
      text: 'Hello World',
      start: 0,
      end: 5,
      x: 10,
      y: 10,
    });

    expect(heard).toEqual([{ type: 'change', start: 0, end: 5, selectedText: 'Hello' }]);
    expect(lastCommand(harness)).toEqual({
      type: 'begin',
      session: 'selection',
      instanceId: 'a',
      x: 10,
      y: 10,
      width: 100,
      height: 20,
      text: 'Hello World',
      start: 0,
      end: 5,
    });
  });

  it('clamps and orders the initial range', async () => {
    const harness = await mountWidget();
    const heard: TextSelectionEvent[] = [];
    harness.api.onTextSelection((event) => heard.push(event));

    harness.api.textSelection.begin({ text: 'abc', start: 99, end: -2, x: 0, y: 0 });

    expect(heard).toEqual([{ type: 'change', start: 0, end: 3, selectedText: 'abc' }]);
  });

  it('reports widget-driven range updates as change events', async () => {
    const harness = await mountWidget();
    const heard: TextSelectionEvent[] = [];
    harness.api.onTextSelection((event) => heard.push(event));

    harness.api.textSelection.begin({ text: 'Hello World', start: 0, end: 5, x: 0, y: 0 });
    harness.api.textSelection.update({ start: 6, end: 11 });

    expect(heard.at(-1)).toEqual({
      type: 'change',
      start: 6,
      end: 11,
      selectedText: 'World',
    });
    expect(lastCommand(harness)).toEqual({
      type: 'update',
      session: 'selection',
      instanceId: 'a',
      start: 6,
      end: 11,
    });
  });

  it('reports native selection changes but dedupes an unchanged echo', async () => {
    const harness = await mountWidget();
    const heard: TextSelectionEvent[] = [];
    harness.api.onTextSelection((event) => heard.push(event));

    harness.api.textSelection.begin({ text: 'Hello World', start: 0, end: 5, x: 0, y: 0 });
    // The host echoes the range the widget just opened: listeners must not see it twice.
    harness.runtime.textSelection('a', { type: 'change', start: 0, end: 5, selectedText: 'Hello' });
    harness.runtime.textSelection('a', {
      type: 'change',
      start: 6,
      end: 11,
      selectedText: 'World',
    });

    expect(heard).toEqual([
      { type: 'change', start: 0, end: 5, selectedText: 'Hello' },
      { type: 'change', start: 6, end: 11, selectedText: 'World' },
    ]);
  });

  it('commits the current native range once', async () => {
    const harness = await mountWidget();
    const heard: TextSelectionEvent[] = [];
    harness.api.onTextSelection((event) => heard.push(event));

    harness.api.textSelection.begin({ text: 'Hello World', start: 0, end: 5, x: 0, y: 0 });
    harness.runtime.textSelection('a', {
      type: 'change',
      start: 6,
      end: 11,
      selectedText: 'World',
    });
    harness.api.textSelection.commit();

    expect(heard.at(-1)).toEqual({
      type: 'commit',
      start: 6,
      end: 11,
      selectedText: 'World',
    });
    expect(lastCommand(harness)).toEqual({
      type: 'commit',
      session: 'selection',
      instanceId: 'a',
    });

    harness.runtime.textSelection('a', { type: 'change', start: 0, end: 1, selectedText: 'H' });
    expect(heard.at(-1)).toMatchObject({ type: 'commit' });
  });

  it('cancels selection and ignores native events afterwards', async () => {
    const harness = await mountWidget();
    const heard: TextSelectionEvent[] = [];
    harness.api.onTextSelection((event) => heard.push(event));

    harness.api.textSelection.begin({ text: 'Hello', start: 1, end: 3, x: 0, y: 0 });
    harness.api.textSelection.cancel();
    harness.runtime.textSelection('a', { type: 'change', start: 0, end: 5, selectedText: 'Hello' });

    expect(heard).toEqual([
      { type: 'change', start: 1, end: 3, selectedText: 'el' },
      { type: 'cancel', start: 1, end: 3, selectedText: 'el' },
    ]);
    expect(lastCommand(harness)).toEqual({
      type: 'cancel',
      session: 'selection',
      instanceId: 'a',
    });
  });

  it('contains selection listener failures and honours unsubscribe', async () => {
    const harness = await mountWidget();
    const received: TextSelectionEvent[] = [];
    const unsubscribe = harness.api.onTextSelection(() => {
      throw new Error('selection listener exploded');
    });
    harness.api.onTextSelection((event) => received.push(event));

    harness.api.textSelection.begin({ text: 'abc', start: 0, end: 1, x: 0, y: 0 });
    unsubscribe();
    harness.api.textSelection.update({ start: 1, end: 2 });

    expect(received).toHaveLength(2);
    expect(errors(harness)).toContainEqual({
      instanceId: 'a',
      phase: 'deliver',
      error: { name: 'Error', message: 'selection listener exploded' },
    });
  });

  it('cancels the host control when a selection instance unmounts', async () => {
    const harness = await mountWidget();
    harness.api.textSelection.begin({ text: 'abc', start: 0, end: 1, x: 0, y: 0 });
    harness.runtime.unmount('a');

    expect(lastCommand(harness)).toEqual({
      type: 'cancel',
      session: 'selection',
      instanceId: 'a',
    });
  });

  it('ignores native selection events before a session starts', async () => {
    const harness = await mountWidget();
    const heard: TextSelectionEvent[] = [];
    harness.api.onTextSelection((event) => heard.push(event));

    harness.runtime.textSelection('a', { type: 'change', start: 0, end: 1, selectedText: 'a' });
    harness.api.textSelection.update({ start: 0, end: 1 });
    harness.api.textSelection.commit();

    expect(heard).toEqual([]);
    expect(commands(harness)).toEqual([]);
  });
});
