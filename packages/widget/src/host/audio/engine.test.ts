import { describe, expect, it } from 'vitest';
import { WidgetAudioEngine } from './engine';
import type { WidgetAudioDiagnosticCode } from '../../guest/audio/protocol';
import { createWidgetAudioRuntime } from '../../guest/audio/controller';
import type { WidgetAudioRuntime } from '../../guest/audio/controller';
import { flush, createWorkletNode, FakeAudioContext } from './test-helpers';
import type { WorkletNodeHarness } from './test-helpers';

interface EngineHarness {
  readonly engine: WidgetAudioEngine;
  readonly context: FakeAudioContext;
  readonly worklet: WorkletNodeHarness;
  readonly reports: { code: WidgetAudioDiagnosticCode; instanceId: string; message: string }[];
  readonly states: string[];
  readonly port: () => MessagePort | undefined;
}

function createHarness(options: { context?: FakeAudioContext } = {}): EngineHarness {
  const worklet = createWorkletNode();
  const context = options.context ?? new FakeAudioContext();
  const reports: EngineHarness['reports'] = [];
  const states: string[] = [];
  let port: MessagePort | undefined;
  const engine = new WidgetAudioEngine({
    context,
    limits: { maxVoices: 2, maxStreams: 2 },
    report: (code, instanceId, message) => reports.push({ code, instanceId, message }),
    notify: {
      emitPort: (next) => {
        port = next;
      },
      emitState: (state) => states.push(state),
    },
    loadWorklet: async () => worklet.node,
  });
  return { engine, context, worklet, reports, states, port: () => port };
}

/** Mounts one instance and gives it a real guest runtime on the handed-over port. */
async function mountGuest(
  harness: EngineHarness,
  instanceId = 'i1',
): Promise<{ runtime: WidgetAudioRuntime; session: string | undefined }> {
  const info = await harness.engine.open(instanceId);
  const runtime = createWidgetAudioRuntime({});
  const port = harness.port();
  if (port !== undefined) runtime.attachPort(port);
  runtime.open(instanceId, info);
  return { runtime, session: info.session };
}

describe('WidgetAudioEngine', () => {
  it('boots the worklet and hands the guest port over', async () => {
    const harness = createHarness();
    const info = await harness.engine.open('i1');

    expect(info.state).toBe('running');
    expect(info.session).toEqual(expect.any(String));
    expect(harness.port()).toBeDefined();
    expect(harness.engine.state).toBe('running');
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('reports unavailable when the browser has no AudioWorklet', async () => {
    const context = {
      sampleRate: 48000,
      state: 'running',
      destination: { connect() {} },
    } as unknown as FakeAudioContext;
    const reports: { code: string; instanceId: string; message: string }[] = [];
    const engine = new WidgetAudioEngine({
      context,
      report: (code, instanceId, message) => reports.push({ code, instanceId, message }),
      notify: { emitPort: () => {}, emitState: () => {} },
    });

    await expect(engine.open('i1')).resolves.toEqual({ state: 'unavailable' });
    expect(engine.state).toBe('unavailable');
    expect(reports).toHaveLength(0);
    engine.dispose();
  });

  it('reports a worklet that fails to load', async () => {
    const reports: { code: string; instanceId: string; message: string }[] = [];
    const engine = new WidgetAudioEngine({
      context: new FakeAudioContext(),
      report: (code, instanceId, message) => reports.push({ code, instanceId, message }),
      notify: { emitPort: () => {}, emitState: () => {} },
      loadWorklet: async () => {
        throw new Error('no worklet');
      },
    });

    await expect(engine.open('i1')).resolves.toEqual({ state: 'unavailable' });
    expect(reports[0]).toMatchObject({ code: 'widget/audio-failed', instanceId: '' });
    engine.dispose();
  });

  it('plays a tone the guest started on the direct port', async () => {
    const harness = createHarness();
    const { runtime, session } = await mountGuest(harness);
    expect(session).toEqual(expect.any(String));

    runtime.api('i1').tone({ type: 'square', frequency: 480, volume: 1 });
    await flush();

    const { left } = harness.worklet.render(128);
    expect(Math.max(...left.map(Math.abs))).toBeGreaterThan(0.5);
    runtime.dispose();
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('applies mute and the instance volume inside the worklet', async () => {
    const harness = createHarness();
    const { runtime } = await mountGuest(harness);
    const stream = runtime.api('i1').createStream({ sampleRate: 48000, bufferMs: 50, startMs: 1 });
    await flush();

    await stream.write(new Float32Array(128).fill(0.5));
    await flush();
    expect(harness.worklet.render(128).left[100]).toBeCloseTo(0.5, 3);

    harness.engine.setInstanceVolume('i1', 0.5);
    await flush();
    await stream.write(new Float32Array(128).fill(0.5));
    await flush();
    expect(harness.worklet.render(128).left[100]).toBeCloseTo(0.25, 3);

    harness.engine.setMuted(true);
    await flush();
    await stream.write(new Float32Array(128).fill(0.5));
    await flush();
    expect(harness.worklet.render(128).left[100]).toBe(0);

    runtime.dispose();
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('validates the instance volume', () => {
    const harness = createHarness();
    expect(() => harness.engine.setInstanceVolume('i1', 'loud' as unknown as number)).toThrow(
      TypeError,
    );
    expect(() => harness.engine.setInstanceVolume('i1', 2)).toThrow(RangeError);
    expect(() => harness.engine.setInstanceVolume('missing', 0.5)).not.toThrow();
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('freezes and resumes PCM through the worklet', async () => {
    const harness = createHarness();
    const { runtime } = await mountGuest(harness);
    const stream = runtime.api('i1').createStream({ sampleRate: 48000, bufferMs: 50, startMs: 1 });
    await flush();
    await stream.write(new Float32Array(128).fill(0.5));
    await flush();

    harness.engine.suspend();
    expect(harness.engine.state).toBe('suspended');
    await flush();
    expect(harness.worklet.render(128).left[100]).toBe(0);

    harness.engine.resume();
    expect(harness.engine.state).toBe('running');
    await flush();
    expect(harness.worklet.render(128).left[100]).toBeCloseTo(0.5, 3);

    runtime.dispose();
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('revokes the session when an instance goes away', async () => {
    const harness = createHarness();
    const { runtime } = await mountGuest(harness);
    const stream = runtime.api('i1').createStream({ sampleRate: 48000 });
    await flush();

    harness.engine.close('i1');
    await expect(stream.ended).resolves.toEqual({ reason: 'stopped' });
    runtime.dispose();
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('closes a session only while it is the current generation', async () => {
    const harness = createHarness();
    const stale = await mountGuest(harness);
    const { runtime } = stale;
    const next = await harness.engine.open('i1');
    runtime.open('i1', next);

    const tone = runtime.api('i1').tone({ frequency: 480, volume: 1 });
    await flush();
    harness.engine.closeSession('i1', stale.session ?? 'stale');
    await flush();

    expect(Math.max(...harness.worklet.render(128).left.map(Math.abs))).toBeGreaterThan(0.5);
    tone.stop();
    runtime.dispose();
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('opens a fresh guest channel after a sandbox reset', async () => {
    const harness = createHarness();
    await mountGuest(harness);
    const first = harness.port();

    harness.engine.reset();
    await flush(16);

    expect(harness.port()).not.toBe(first);
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('reports worklet limits against the instance that owns the session', async () => {
    const harness = createHarness();
    const { runtime } = await mountGuest(harness);

    // The guest accepts four streams; this host tightened the ceiling to two.
    runtime.api('i1').createStream({ sampleRate: 48000 });
    runtime.api('i1').createStream({ sampleRate: 48000 });
    runtime.api('i1').createStream({ sampleRate: 48000 });
    await flush();

    expect(harness.reports).toEqual([
      expect.objectContaining({ code: 'widget/audio-limit', instanceId: 'i1' }),
    ]);
    runtime.dispose();
    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('mirrors the context state onto the guests', async () => {
    const harness = createHarness();
    await mountGuest(harness);

    harness.context.setState('suspended');
    expect(harness.engine.state).toBe('suspended');
    expect(harness.states.at(-1)).toBe('suspended');

    harness.context.setState('running');
    expect(harness.engine.state).toBe('running');
    expect(harness.states.at(-1)).toBe('running');

    harness.engine.dispose();
    harness.worklet.dispose();
  });

  it('stops listening to the context once disposed', async () => {
    const harness = createHarness();
    await mountGuest(harness);
    harness.engine.dispose();
    const count = harness.states.length;

    harness.context.setState('suspended');
    expect(harness.states).toHaveLength(count);
    harness.worklet.dispose();
  });

  it('releases the worklet when dispose runs while it is loading', async () => {
    const worklet = createWorkletNode();
    const context = new FakeAudioContext();
    let release: () => void = () => {};
    context.moduleReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reports: unknown[] = [];
    const engine = new WidgetAudioEngine({
      context,
      report: (code, instanceId, message) => reports.push({ code, instanceId, message }),
      notify: { emitPort: () => {}, emitState: () => {} },
      loadWorklet: async () => {
        await context.moduleReady;
        return worklet.node;
      },
    });

    const opening = engine.open('i1');
    engine.dispose();
    release();
    await expect(opening).resolves.toEqual({ state: 'unavailable' });
    expect(reports).toHaveLength(0);
    worklet.dispose();
  });
});
