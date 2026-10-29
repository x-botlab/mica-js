import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxWorkerError, SandboxWorkerOptions } from '../types';
import { SandboxWorker } from './sandbox';

const code = "self.addEventListener('message', () => {});";

interface FrameMessage {
  readonly data: unknown;
  readonly transfer: readonly unknown[];
}

interface FakeWindow {
  postMessage(message: unknown, origin: string, transfer?: readonly unknown[]): void;
}

interface FakeFrame {
  readonly attributes: Record<string, string>;
  readonly posted: FrameMessage[];
  readonly style: { cssText: string };
  contentWindow: FakeWindow;
  srcdoc: string;
  src: string;
  title: string;
  tabIndex: number;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface Harness {
  frames: FakeFrame[];
  listeners: Set<
    (event: { data: unknown; source: unknown; ports: readonly MessagePort[] }) => void
  >;
  document: unknown;
  window: unknown;
  frame(): FakeFrame;
  emit(data: unknown, source?: unknown, ports?: readonly MessagePort[]): void;
}

function createHarness(): Harness {
  const harness: Harness = {
    frames: [],
    listeners: new Set(),
    frame(): FakeFrame {
      const frame = harness.frames.at(-1);
      if (!frame) throw new Error('no frame was created');
      return frame;
    },
    emit(data, source, ports = []) {
      for (const listener of [...harness.listeners]) {
        listener({ data, source: source ?? harness.frame().contentWindow, ports });
      }
    },
    document: undefined,
    window: undefined,
  };

  const createFrame = (): FakeFrame => {
    const posted: FrameMessage[] = [];
    const frame: FakeFrame = {
      attributes: {},
      posted,
      style: { cssText: '' },
      contentWindow: {
        postMessage(message, _origin, transfer = []) {
          posted.push({ data: message, transfer });
        },
      },
      srcdoc: '',
      src: '',
      title: '',
      tabIndex: 0,
      removed: false,
      setAttribute(name, value) {
        frame.attributes[name] = value;
      },
      remove() {
        frame.removed = true;
      },
    };
    harness.frames.push(frame);
    return frame;
  };

  harness.document = {
    body: {
      append(frame: unknown) {
        expect(harness.frames).toContain(frame);
      },
    },
    createElement: () => createFrame(),
    querySelector: () => null,
  };
  harness.window = {
    addEventListener(
      type: string,
      listener: (event: { data: unknown; source: unknown; ports: readonly MessagePort[] }) => void,
    ) {
      if (type === 'message') harness.listeners.add(listener);
    },
    removeEventListener(
      type: string,
      listener: (event: { data: unknown; source: unknown; ports: readonly MessagePort[] }) => void,
    ) {
      if (type === 'message') harness.listeners.delete(listener);
    },
  };

  return harness;
}

const globals = globalThis as unknown as { document?: unknown; window?: unknown };
let harness: Harness;
let originalDocument: unknown;
let originalWindow: unknown;

beforeEach(() => {
  originalDocument = globals.document;
  originalWindow = globals.window;
  harness = createHarness();
  globals.document = harness.document;
  globals.window = harness.window;
});

afterEach(() => {
  globals.document = originalDocument;
  globals.window = originalWindow;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function boot(options: SandboxWorkerOptions = {}): Promise<SandboxWorker> {
  const sandbox = new SandboxWorker(code, { name: 'test', ...options });
  await tick();
  harness.emit({ type: 'mica:frame-ready' });
  await tick();
  return sandbox;
}

async function start(options: SandboxWorkerOptions = {}): Promise<SandboxWorker> {
  const sandbox = await boot(options);
  harness.emit({ type: 'mica:worker-started' });
  return sandbox;
}

describe('SandboxWorker', () => {
  it('creates an offscreen iframe for the bootstrap', async () => {
    const sandbox = await boot();

    const frame = harness.frame();
    expect(frame.attributes['sandbox']).toBe('allow-scripts');
    expect(frame.style.cssText).toContain('position:fixed');
    expect(frame.srcdoc).toContain('mica:frame-ready');
    expect(sandbox.state).toBe('ready');
    await sandbox.terminate();
  });

  it('posts ordinary caller messages with their transfer list', async () => {
    const extra = new MessageChannel().port2;
    const sandbox = await start();

    expect(harness.frame().posted[0]?.data).toEqual({ type: 'mica:boot', code });
    sandbox.postMessage({ mode: 'widget' }, [extra]);

    const message = harness.frame().posted[1];
    expect(message?.data).toEqual({ mode: 'widget' });
    expect(message?.transfer).toEqual([extra]);
    await sandbox.terminate();
  });

  it('queues messages until the real worker starts', async () => {
    const extra = new MessageChannel().port2;
    const sandbox = new SandboxWorker(code, { name: 'test' });
    sandbox.postMessage({ ping: 1 }, [extra]);
    await tick();
    harness.emit({ type: 'mica:frame-ready' });
    await tick();
    harness.emit({ type: 'mica:worker-started' });
    await expect(sandbox.ready).resolves.toBeUndefined();
    expect(harness.frame().posted[1]).toEqual({ data: { ping: 1 }, transfer: [extra] });
    await sandbox.terminate();
  });

  it('forwards worker messages and message errors', async () => {
    const sandbox = await start();
    const messages: unknown[] = [];
    const errors: unknown[] = [];
    sandbox.onmessage = (event) => messages.push(event.data);
    sandbox.onmessageerror = (event) => errors.push(event.data);

    harness.emit({ type: 'mica:worker-message', data: { pong: 1 } });
    harness.emit({ type: 'mica:worker-messageerror', data: { bad: true } });

    expect(messages).toEqual([{ pong: 1 }]);
    expect(errors).toEqual([{ bad: true }]);
    await sandbox.terminate();
  });

  it('rejects ready when the frame cannot start the worker', async () => {
    const sandbox = await boot();

    harness.emit({ type: 'mica:frame-error', message: 'worker construction blocked' });

    await expect(sandbox.ready).rejects.toMatchObject({
      name: 'SandboxError',
      code: 'boot-failed',
      message: 'worker construction blocked',
    });
  });

  it('rejects ready when the bootstrap never answers', async () => {
    const sandbox = new SandboxWorker(code, { name: 'test', bootTimeoutMs: 5 });

    await expect(sandbox.ready).rejects.toMatchObject({ code: 'boot-timeout' });
    expect(sandbox.state).toBe('terminated');
  });

  it('forwards uncaught worker failures to onError subscribers', async () => {
    const sandbox = await start();
    const errors: SandboxWorkerError[] = [];
    const unsubscribe = sandbox.onError((error) => errors.push(error));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    harness.emit({
      type: 'mica:worker-error',
      message: 'boom',
      filename: 'blob:guest',
      lineno: 2,
      colno: 9,
    });
    unsubscribe();
    harness.emit({ type: 'mica:worker-error', message: 'ignored' });

    expect(errors).toEqual([{ message: 'boom', filename: 'blob:guest', lineno: 2, colno: 9 }]);
    // A failure nobody subscribed to is still reported.
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
    await sandbox.terminate();
  });

  it('terminates the worker and releases the frame', async () => {
    const sandbox = await start();

    await sandbox.terminate('done');

    expect(sandbox.state).toBe('terminated');
    expect(harness.frame().removed).toBe(true);
    expect(harness.frame().posted.at(-1)?.data).toEqual({ type: 'mica:terminate', control: true });
    expect(harness.listeners.size).toBe(0);
  });

  it('rejects ready when a sandbox is terminated before it starts', async () => {
    const sandbox = await boot();

    await sandbox.terminate('disposed');

    await expect(sandbox.ready).rejects.toMatchObject({ code: 'terminated' });
  });
});
