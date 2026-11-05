import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '@mica-js/core/lifecycle';
import { timePs } from '@mica-js/core';
import type { CanvasDocument } from '@mica-js/document/canvas';
import type { IWidgetFrame } from '@mica-js/widget';
import { CanvasSession } from './session';
import type { ICanvasRuntimes } from './runtime-factory';

const id = '11111111-1111-4111-8111-111111111111';
const document: CanvasDocument = {
  version: 1,
  widgets: [{ id, widget: 'demo:display', x: 0, y: 0, width: 100, height: 60, rotation: 0 }],
};
const module = { definition: { properties: {}, ports: {} }, code: '' };
function pair() {
  const frames = new Emitter<IWidgetFrame>();
  const widgets = {
    onDidRender: frames.event,
    mount: vi.fn(async () => {}),
    setBindings: vi.fn(async () => {}),
    step: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}),
  };
  const simulation = {
    load: vi.fn(async () => {}),
    tick: vi.fn(async () => ({ simTime: timePs(25_000_000_000), executed: 1 })),
  };
  const dispose = vi.fn(async () => {});
  return { frames, widgets, simulation, dispose };
}
function setup() {
  const pairs: ReturnType<typeof pair>[] = [];
  const factory = {
    create: vi.fn(async () => {
      const result = pair();
      pairs.push(result);
      return result as unknown as ICanvasRuntimes;
    }),
  };
  const session = new CanvasSession(
    { uri: 'https://test/main.cnv', container: {} as HTMLElement },
    { read: vi.fn() },
    { resolve: async () => undefined },
    { resolve: async () => module },
    factory,
  );
  return { session, factory, pairs };
}

describe('editor-owned canvas runtime session', () => {
  it('keeps placement changes in the editor without remounting runtime instances', async () => {
    const { session, factory, pairs } = setup();
    await session.synchronize(document);
    await session.synchronize({
      ...document,
      widgets: [{ ...document.widgets[0]!, x: 50, rotation: 30 }],
    });
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(pairs[0]!.widgets.mount).toHaveBeenCalledTimes(1);
    await session.dispose();
    expect(pairs[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('retains the previous runtime when a new instance fails to mount', async () => {
    const { session, factory, pairs } = setup();
    await session.synchronize(document);
    const failed = pair();
    failed.widgets.mount.mockRejectedValueOnce(new Error('mount failed'));
    factory.create.mockResolvedValueOnce(failed as unknown as ICanvasRuntimes);
    await expect(
      session.synchronize({ ...document, widgets: [{ ...document.widgets[0]!, width: 120 }] }),
    ).rejects.toThrow('mount failed');
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    expect(pairs[0]!.dispose).not.toHaveBeenCalled();
    await session.synchronize(document);
    expect(factory.create).toHaveBeenCalledTimes(2);
    await session.dispose();
  });

  it('owns the only clock and runs simulation before the widget frame', async () => {
    const { session, pairs } = setup();
    await session.synchronize(document);
    await session.setMode('simulation');
    const active = pairs[1]!;
    await session.step();
    expect(active.simulation.tick).toHaveBeenCalledExactlyOnceWith(timePs(25_000_000_000));
    expect(active.widgets.step).toHaveBeenLastCalledWith({
      simTime: timePs(25_000_000_000),
      dt: timePs(25_000_000_000),
      mode: 'simulation',
    });
    expect(active.simulation.tick.mock.invocationCallOrder[0]).toBeLessThan(
      active.widgets.step.mock.invocationCallOrder.at(-1)!,
    );
    expect(session.status).toEqual({
      mode: 'simulation',
      running: false,
      simTime: timePs(25_000_000_000),
    });
    await session.dispose();
  });

  it('isolates rendering to the active runtime and closes subscriptions on replacement', async () => {
    const { session, pairs } = setup();
    await session.synchronize(document);
    const listener = vi.fn();
    session.onDidRender(listener);
    const frame = {
      instanceId: id,
      bitmap: {} as ImageBitmap,
      width: 100,
      height: 60,
      dpr: 1,
      sequence: 1,
    };
    pairs[0]!.frames.fire(frame);
    expect(session.getFrame(id)).toBe(frame);
    await session.reset();
    listener.mockClear();
    pairs[0]!.frames.fire(frame);
    expect(listener).not.toHaveBeenCalled();
    expect(session.getFrame(id)).toBeUndefined();
    const disposal = session.dispose();
    expect(session.dispose()).toBe(disposal);
    await disposal;
    await expect(session.step()).rejects.toThrow('disposed');
  });

  it('cancels candidate adoption if disposed while mounting', async () => {
    const { session, factory } = setup();
    const candidate = pair();
    let finish!: () => void;
    candidate.widgets.mount.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    factory.create.mockResolvedValueOnce(candidate as unknown as ICanvasRuntimes);
    const initializing = session.synchronize(document);
    await vi.waitFor(() => expect(candidate.widgets.mount).toHaveBeenCalled());
    const closing = session.dispose();
    finish();
    await expect(initializing).rejects.toThrow('disposed');
    await closing;
    expect(candidate.dispose).toHaveBeenCalledTimes(1);
    expect(session.getFrame(id)).toBeUndefined();
  });
});
