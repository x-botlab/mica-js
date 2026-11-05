import { describe, expect, it, vi } from 'vitest';
import { createWidgetRuntime as createGuestRuntime } from '../guest/widget/runtime';
import type { WidgetRuntime as GuestRuntime, WidgetRuntimeChannel } from '../guest/widget/runtime';
import type { WidgetSandbox } from '../host/types';
import type { WidgetModule } from '../types';
import { createWidgetRuntime } from './runtime';
import type { IPreparedWidgetInstance, IWidgetRuntimeDiagnostic } from './types';

interface IFakeBitmap {
  closed: boolean;
  close(): void;
}

class FakeCanvas {
  width: number;
  height: number;
  readonly context = { setTransform: vi.fn(), clearRect: vi.fn() };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(kind: string): unknown {
    return kind === '2d' ? this.context : null;
  }

  transferToImageBitmap(): IFakeBitmap {
    const bitmap: IFakeBitmap = { closed: false, close: () => (bitmap.closed = true) };
    return bitmap;
  }
}

type Listener = (payload: unknown) => void;

class EventBus implements WidgetRuntimeChannel {
  readonly #listeners = new Map<string, Set<Listener>>();

  on(type: string, listener: Listener): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => {
      this.#listeners.get(type)?.delete(listener);
    };
  }

  emit(type: string, payload?: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(payload);
  }
}

/** Real guest runtime behind the `WidgetSandbox` surface the host runtime consumes. */
class GuestSandbox implements WidgetSandbox {
  state: 'ready' | 'terminated' = 'ready';
  readonly #guest: GuestRuntime;
  readonly #bus: EventBus;

  constructor(guest: GuestRuntime, bus: EventBus) {
    this.#guest = guest;
    this.#bus = bus;
  }

  call(method: string, ...args: unknown[]): Promise<unknown> {
    const target = this.#guest as unknown as Record<
      string,
      ((...args: unknown[]) => unknown) | undefined
    >;
    return Promise.resolve().then(() => target[method]?.(...args));
  }

  on(type: string, listener: Listener): () => void {
    return this.#bus.on(type, listener);
  }

  terminate(): Promise<void> {
    this.state = 'terminated';
    this.#guest.dispose();
    return Promise.resolve();
  }
}

const definition: WidgetModule['definition'] = { properties: {}, ports: {} };

function prepared(): IPreparedWidgetInstance {
  return {
    instanceId: 'a',
    widget: 'demo:indicator',
    module: { definition, code: 'widget' },
    width: 20,
    height: 10,
    dpr: 1,
  };
}

function createHarness(factory: () => { render?: () => void }) {
  const bus = new EventBus();
  const guest = createGuestRuntime(bus, { importModule: async () => ({ default: factory }) });
  const runtime = createWidgetRuntime(new GuestSandbox(guest, bus));
  const diagnostics: IWidgetRuntimeDiagnostic[] = [];
  runtime.onDidDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  return { runtime, diagnostics };
}

describe('widget runtime with a real guest', () => {
  it('rejects mount when the guest factory fails, then adopts a retry', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let calls = 0;
    const { runtime, diagnostics } = createHarness(() => {
      calls += 1;
      if (calls === 1) throw new Error('factory exploded');
      return {};
    });

    await expect(runtime.mount(prepared())).rejects.toMatchObject({
      code: 'widget/sandbox-failed',
    });
    expect(calls).toBe(1);
    expect(diagnostics.some((entry) => entry.code === 'widget/mount-failed')).toBe(true);
    await expect(runtime.update('a', { width: 1 })).rejects.toMatchObject({
      code: 'widget/unknown-instance',
    });

    await runtime.mount(prepared());
    expect(calls).toBe(2);
    await runtime.update('a', { width: 30 });
    await runtime.dispose();
  });

  it('rejects mount when the guest first paint fails', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let calls = 0;
    const { runtime, diagnostics } = createHarness(() => {
      calls += 1;
      if (calls === 1) {
        return {
          render: () => {
            throw new Error('bad paint');
          },
        };
      }
      return {};
    });

    await expect(runtime.mount(prepared())).rejects.toMatchObject({
      code: 'widget/sandbox-failed',
    });
    expect(diagnostics.some((entry) => entry.code === 'widget/mount-failed')).toBe(true);
    await expect(runtime.update('a', { width: 1 })).rejects.toMatchObject({
      code: 'widget/unknown-instance',
    });

    await runtime.mount(prepared());
    expect(calls).toBe(2);
    await runtime.dispose();
  });
});
