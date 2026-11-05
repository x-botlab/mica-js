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
    audio: { suspend: vi.fn(), resume: vi.fn() },
  };
  const simulation = {
    load: vi.fn(async () => {}),
    tick: vi.fn(async () => ({ simTime: timePs(20_000_000_000), executed: 1 })),
  };
  const dispose = vi.fn(async () => {});
  return { frames, widgets, simulation, dispose, resumeAudio: vi.fn(async () => {}) };
}
function setup(stepMs?: number) {
  const pairs: ReturnType<typeof pair>[] = [];
  const factory = {
    create: vi.fn(async () => {
      const result = pair();
      pairs.push(result);
      return result as unknown as ICanvasRuntimes;
    }),
  };
  const container = new EventTarget() as HTMLElement;
  const session = new CanvasSession(
    {
      uri: 'https://test/main.cnv',
      container,
      ...(stepMs === undefined ? {} : { stepMs }),
    },
    { read: vi.fn() },
    { resolve: async () => undefined },
    { resolve: async () => module },
    factory,
  );
  return { session, factory, pairs, container };
}

describe('editor-owned canvas runtime session', () => {
  it('resumes audio on run and gestures, and suspends it on pause and reset', async () => {
    const { session, pairs, container } = setup();
    const remove = vi.spyOn(container, 'removeEventListener');
    try {
      await session.synchronize(document);
      container.dispatchEvent(new Event('pointerdown'));
      expect(pairs[0]!.resumeAudio).not.toHaveBeenCalled();
      await session.setMode('simulation');
      const active = pairs[1]!;
      await session.step();
      expect(active.widgets.audio.resume).not.toHaveBeenCalled();
      session.run();
      expect(active.widgets.audio.resume).toHaveBeenCalledOnce();
      expect(active.resumeAudio).toHaveBeenCalledOnce();
      container.dispatchEvent(new Event('pointerdown'));
      container.dispatchEvent(new Event('keydown'));
      expect(active.resumeAudio).toHaveBeenCalledTimes(3);
      session.pause();
      expect(active.widgets.audio.suspend).toHaveBeenCalledOnce();
      container.dispatchEvent(new Event('pointerdown'));
      expect(active.resumeAudio).toHaveBeenCalledTimes(3);
      session.run();
      await session.reset();
      expect(active.widgets.audio.suspend).toHaveBeenCalledTimes(2);
      expect(active.dispose).toHaveBeenCalledOnce();
      expect(pairs[2]!.widgets.audio.resume).not.toHaveBeenCalled();
      session.run();
      await session.setMode('edit');
      expect(pairs[2]!.widgets.audio.suspend).toHaveBeenCalledOnce();
      expect(pairs[3]!.widgets.audio.resume).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });

  it('reports resume failures without stopping simulation and retries on the next gesture', async () => {
    const { session, pairs, container } = setup();
    const report = vi.fn();
    session.onDidError(report);
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      const error = new Error('autoplay blocked');
      active.resumeAudio.mockRejectedValueOnce(error);
      session.run();
      await Promise.resolve();
      expect(report).toHaveBeenCalledWith(error);
      expect(session.status.running).toBe(true);
      container.dispatchEvent(new Event('pointerdown'));
      expect(active.resumeAudio).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  it.each([undefined, 10])(
    'keeps frame deadlines with stepMs=%s despite execution time',
    async (stepMs) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const period = stepMs ?? 20;
      const { session, pairs } = setup(stepMs);
      try {
        await session.synchronize(document);
        await session.setMode('simulation');
        const active = pairs[1]!;
        const starts: number[] = [];
        active.simulation.tick.mockImplementation(async () => {
          starts.push(performance.now());
          await new Promise<void>((resolve) => setTimeout(resolve, 3));
          return { simTime: timePs(20_000_000_000), executed: 1 };
        });
        session.run();
        await vi.advanceTimersByTimeAsync(period * 3 + 3);
        expect(starts).toEqual([period, period * 2, period * 3]);
        expect(active.simulation.tick).toHaveBeenLastCalledWith(timePs(period * 1_000_000_000));
      } finally {
        await session.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('skips missed frame slots without overlapping or catching up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { session, pairs } = setup();
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      const starts: number[] = [];
      active.simulation.tick.mockImplementation(async () => {
        starts.push(performance.now());
        await new Promise<void>((resolve) => setTimeout(resolve, 45));
        return { simTime: timePs(20_000_000_000), executed: 1 };
      });
      session.run();
      await vi.advanceTimersByTimeAsync(125);
      expect(starts).toEqual([20, 80]);
      expect(active.simulation.tick).toHaveBeenLastCalledWith(timePs(20_000_000_000));
      session.pause();
      await vi.advanceTimersByTimeAsync(15);
      expect(active.simulation.tick).toHaveBeenCalledTimes(2);
      expect(active.widgets.step).toHaveBeenLastCalledWith(
        expect.objectContaining({ dt: timePs(0) }),
      );
      await session.dispose();
      await vi.advanceTimersByTimeAsync(100);
      expect(starts).toEqual([20, 80]);
    } finally {
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid stepMs=%s', (stepMs) => {
    expect(() => setup(stepMs)).toThrow('stepMs');
  });
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
    expect(active.simulation.tick).toHaveBeenCalledExactlyOnceWith(timePs(20_000_000_000));
    expect(active.widgets.step).toHaveBeenLastCalledWith({
      simTime: timePs(20_000_000_000),
      dt: timePs(20_000_000_000),
      mode: 'simulation',
    });
    expect(active.simulation.tick.mock.invocationCallOrder[0]).toBeLessThan(
      active.widgets.step.mock.invocationCallOrder.at(-1)!,
    );
    expect(session.status).toEqual({
      mode: 'simulation',
      running: false,
      simTime: timePs(20_000_000_000),
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
