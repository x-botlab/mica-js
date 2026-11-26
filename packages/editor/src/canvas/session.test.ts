import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '@mica-js/core/lifecycle';
import { timePs } from '@mica-js/core';
import type { CanvasDocument } from '@mica-js/document/canvas';
import type { IWidgetFrame, IWidgetFrameContext } from '@mica-js/widget';
import { CanvasSession, type ICanvasAdvanceObserver, type ICanvasAdvanceSample } from './session';
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
    step: vi.fn<(_context: IWidgetFrameContext) => Promise<void>>(async () => {}),
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
function setup(
  stepMs?: number,
  execution?: 'throughput' | 'precise',
  observer?: ICanvasAdvanceObserver,
  hooks?: {
    readonly onAdvanceStart?: () => void;
    readonly onAdvanceSettled?: () => void;
  },
  batchExecution?: boolean,
) {
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
      ...(execution === undefined ? {} : { execution }),
      ...(batchExecution === undefined ? {} : { batchExecution }),
      ...(observer === undefined ? {} : { observer }),
      ...(hooks?.onAdvanceStart === undefined ? {} : { onAdvanceStart: hooks.onAdvanceStart }),
      ...(hooks?.onAdvanceSettled === undefined
        ? {}
        : { onAdvanceSettled: hooks.onAdvanceSettled }),
    },
    { read: vi.fn() },
    { resolve: async () => undefined },
    { resolve: async () => module },
    factory,
  );
  return { session, factory, pairs, container };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Lets every in-flight fake-time round settle before disposal when an assertion fails early. */
async function settleAndDispose(session: CanvasSession): Promise<void> {
  session.pause();
  await vi.advanceTimersByTimeAsync(1_000);
  await session.dispose();
}

describe('editor-owned canvas runtime session', () => {
  it('passes the configured CPU execution mode to the simulation runtime', async () => {
    const { session, pairs } = setup(undefined, 'precise');
    try {
      await session.synchronize(document);
      expect(pairs[0]!.simulation.load).toHaveBeenCalledWith(
        expect.objectContaining({ execution: 'precise' }),
      );
    } finally {
      await session.dispose();
    }
  });

  it('passes the batch-execution switch through the typed runtime load', async () => {
    const { session, pairs } = setup(undefined, undefined, undefined, undefined, true);
    try {
      await session.synchronize(document);
      expect(pairs[0]!.simulation.load).toHaveBeenCalledWith(
        expect.objectContaining({ batchExecution: true }),
      );
    } finally {
      await session.dispose();
    }
  });

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

  it('measures round trips, cadence, idle and completed simTime without changing cadence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const samples: ICanvasAdvanceSample[] = [];
    const { session, pairs } = setup(20, undefined, (sample) => samples.push(sample));
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      let simTime = timePs(0);
      active.simulation.tick.mockImplementation(async () => {
        await delay(5);
        simTime = timePs(simTime + 20_000_000_000);
        return { simTime, executed: 1 };
      });
      active.widgets.step.mockImplementation(() => delay(3));
      session.run();
      await vi.advanceTimersByTimeAsync(49);
      expect(samples.map((sample) => sample.startedAt)).toEqual([20, 40]);
      expect(samples[0]).toMatchObject({
        sequence: 1,
        trigger: 'frame',
        tickMs: 5,
        widgetMs: 3,
        idleMs: undefined,
        periodMs: undefined,
        skippedSlots: 0,
        simTime: timePs(20_000_000_000),
        dt: timePs(20_000_000_000),
        running: true,
        mode: 'simulation',
        frameMs: 20,
      });
      expect(samples[1]).toMatchObject({
        sequence: 2,
        tickMs: 5,
        widgetMs: 3,
        idleMs: 12,
        periodMs: 20,
        skippedSlots: 0,
        simTime: timePs(40_000_000_000),
      });
    } finally {
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('signals advance start before a slow tick and settle after it completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const events: string[] = [];
    const { session, pairs } = setup(20, undefined, undefined, {
      onAdvanceStart: () => events.push('start'),
      onAdvanceSettled: () => events.push('settled'),
    });
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      let release!: () => void;
      active.simulation.tick.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ simTime: timePs(20_000_000_000), executed: 1 });
          }),
      );
      session.run();
      await vi.advanceTimersByTimeAsync(20);
      expect(events).toEqual(['start']);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['start', 'settled']);
    } finally {
      await settleAndDispose(session);
      vi.useRealTimers();
    }
  });

  it('observes manual steps without consuming a frame slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const samples: ICanvasAdvanceSample[] = [];
    const { session } = setup(20, undefined, (sample) => samples.push(sample));
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      await session.step();
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({
        sequence: 1,
        trigger: 'step',
        tickMs: 0,
        widgetMs: 0,
        idleMs: undefined,
        periodMs: undefined,
        skippedSlots: 0,
        dt: timePs(20_000_000_000),
        running: false,
        mode: 'simulation',
        frameMs: 20,
      });
    } finally {
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('continues immediately after an overrunning tick without overlapping rounds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const samples: ICanvasAdvanceSample[] = [];
    const { session, pairs } = setup(20, undefined, (sample) => samples.push(sample));
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      const starts: number[] = [];
      let activeTicks = 0;
      let maxActiveTicks = 0;
      let completed = 0;
      active.simulation.tick.mockImplementation(async () => {
        starts.push(performance.now());
        activeTicks += 1;
        maxActiveTicks = Math.max(maxActiveTicks, activeTicks);
        await delay(45);
        activeTicks -= 1;
        completed += 1;
        return { simTime: timePs(completed * 20_000_000_000), executed: 1 };
      });
      session.run();
      await vi.advanceTimersByTimeAsync(125);
      // Each late round yields through a zero-delay timer before starting, so fake time advances
      // by one millisecond per continuation.
      expect(starts).toEqual([20, 66, 112]);
      expect(maxActiveTicks).toBe(1);
      expect(active.simulation.tick).toHaveBeenCalledTimes(3);
      expect(session.status.simTime).toBe(timePs(40_000_000_000));
      expect(samples).toHaveLength(2);
      expect(samples[1]).toMatchObject({
        startedAt: 66,
        tickMs: 45,
        widgetMs: 0,
        idleMs: 1,
        periodMs: 46,
        skippedSlots: 1,
        simTime: timePs(40_000_000_000),
        dt: timePs(20_000_000_000),
        running: true,
      });
      for (const [index, sample] of samples.entries())
        if (index > 0)
          expect(sample.startedAt).toBeGreaterThanOrEqual(samples[index - 1]!.completedAt);

      session.pause();
      await vi.advanceTimersByTimeAsync(45);
      expect(starts).toEqual([20, 66, 112]);
      expect(active.simulation.tick).toHaveBeenCalledTimes(3);
      expect(session.status.simTime).toBe(timePs(60_000_000_000));
      expect(active.widgets.step).toHaveBeenLastCalledWith(
        expect.objectContaining({ dt: timePs(0) }),
      );
    } finally {
      await settleAndDispose(session);
      vi.useRealTimers();
    }
  });

  it('keeps one round in flight when the widget step overruns and reports its round trip', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const samples: ICanvasAdvanceSample[] = [];
    const { session, pairs } = setup(20, undefined, (sample) => samples.push(sample));
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      const widgetStarts: number[] = [];
      let activeWidgets = 0;
      let maxActiveWidgets = 0;
      active.simulation.tick.mockImplementation(() =>
        delay(2).then(() => ({ simTime: timePs(20_000_000_000), executed: 1 })),
      );
      active.widgets.step.mockImplementation(async (context) => {
        if (context.dt === timePs(0)) return;
        widgetStarts.push(performance.now());
        activeWidgets += 1;
        maxActiveWidgets = Math.max(maxActiveWidgets, activeWidgets);
        await delay(45);
        activeWidgets -= 1;
      });
      session.run();
      await vi.advanceTimersByTimeAsync(120);
      expect(widgetStarts).toEqual([22, 70, 118]);
      expect(maxActiveWidgets).toBe(1);
      expect(active.simulation.tick).toHaveBeenCalledTimes(3);
      expect(samples).toHaveLength(2);
      expect(samples[0]).toMatchObject({
        startedAt: 20,
        tickMs: 2,
        widgetMs: 45,
        skippedSlots: 0,
        dt: timePs(20_000_000_000),
      });
      expect(samples[1]).toMatchObject({
        startedAt: 68,
        tickMs: 2,
        widgetMs: 45,
        idleMs: 1,
        periodMs: 48,
        skippedSlots: 1,
        dt: timePs(20_000_000_000),
      });

      session.pause();
      await vi.advanceTimersByTimeAsync(45);
      expect(widgetStarts).toEqual([22, 70, 118]);
      expect(active.widgets.step).toHaveBeenLastCalledWith(
        expect.objectContaining({ dt: timePs(0) }),
      );
    } finally {
      await settleAndDispose(session);
      vi.useRealTimers();
    }
  });

  it('does not compensate missed slots after long ticks or grow simTime beyond completed ticks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const samples: ICanvasAdvanceSample[] = [];
    const { session, pairs } = setup(20, undefined, (sample) => samples.push(sample));
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      const starts: number[] = [];
      let activeTicks = 0;
      let maxActiveTicks = 0;
      let completed = 0;
      active.simulation.tick.mockImplementation(async () => {
        starts.push(performance.now());
        activeTicks += 1;
        maxActiveTicks = Math.max(maxActiveTicks, activeTicks);
        await delay(50);
        activeTicks -= 1;
        completed += 1;
        return { simTime: timePs(completed * 20_000_000_000), executed: 1 };
      });
      session.run();
      await vi.advanceTimersByTimeAsync(300);
      expect(starts).toEqual([20, 71, 122, 173, 224, 275]);
      expect(maxActiveTicks).toBe(1);
      expect(completed).toBe(5);
      expect(session.status.simTime).toBe(timePs(100_000_000_000));
      expect(samples).toHaveLength(5);
      expect(starts.length).toBeLessThan(10);

      session.pause();
      await vi.advanceTimersByTimeAsync(30);
      expect(starts).toEqual([20, 71, 122, 173, 224, 275]);
      expect(completed).toBe(6);
      expect(session.status.simTime).toBe(timePs(120_000_000_000));
      for (const [index, sample] of samples.entries())
        if (index > 0)
          expect(sample.startedAt).toBeGreaterThanOrEqual(samples[index - 1]!.completedAt);
    } finally {
      await settleAndDispose(session);
      vi.useRealTimers();
    }
  });

  it('settles the in-flight round on pause and resumes on the same cadence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const samples: ICanvasAdvanceSample[] = [];
    const { session, pairs } = setup(20, undefined, (sample) => samples.push(sample));
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      const starts: number[] = [];
      let simTime = timePs(0);
      active.simulation.tick.mockImplementation(async () => {
        starts.push(performance.now());
        await delay(40);
        simTime = timePs(simTime + 20_000_000_000);
        return { simTime, executed: 1 };
      });
      active.widgets.step.mockClear();
      session.run();
      await vi.advanceTimersByTimeAsync(30);
      expect(starts).toEqual([20]);
      session.pause();
      await vi.advanceTimersByTimeAsync(100);
      expect(starts).toEqual([20]);
      expect(active.simulation.tick).toHaveBeenCalledTimes(1);
      expect(samples[0]).toMatchObject({
        trigger: 'frame',
        dt: timePs(20_000_000_000),
        running: true,
      });
      expect(samples.slice(1).every((sample) => sample.running === false)).toBe(true);
      expect(samples.slice(1).every((sample) => sample.dt === timePs(0))).toBe(true);
      const stepCalls = active.widgets.step.mock.calls.map(([context]) => context.dt);
      expect(stepCalls[0]).toBe(timePs(20_000_000_000));
      expect(stepCalls.slice(1).every((dt) => dt === timePs(0))).toBe(true);
      expect(session.status.simTime).toBe(timePs(20_000_000_000));

      session.run();
      await vi.advanceTimersByTimeAsync(15);
      expect(starts).toEqual([20, 141]);
      expect(session.status.running).toBe(true);
      session.pause();
      await vi.advanceTimersByTimeAsync(40);
      expect(active.simulation.tick).toHaveBeenCalledTimes(2);
      expect(session.status.simTime).toBe(timePs(40_000_000_000));
    } finally {
      await settleAndDispose(session);
      vi.useRealTimers();
    }
  });

  it('contains observer failures so the frame loop keeps its cadence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const error = new Error('observer failed');
    const observer = vi.fn((sample: ICanvasAdvanceSample) => {
      if (sample.sequence === 1) throw error;
    });
    const { session, pairs } = setup(20, undefined, observer);
    try {
      await session.synchronize(document);
      await session.setMode('simulation');
      const active = pairs[1]!;
      const starts: number[] = [];
      active.simulation.tick.mockImplementation(async () => {
        starts.push(performance.now());
        await delay(5);
        return { simTime: timePs(20_000_000_000), executed: 1 };
      });
      const report = vi.fn();
      session.onDidError(report);
      session.run();
      await vi.advanceTimersByTimeAsync(49);
      expect(starts).toEqual([20, 40]);
      expect(observer).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenCalledWith(error);
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
