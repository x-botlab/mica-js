import { describe, expect, it } from 'vitest';
import { createWidgetAudioRuntime } from './controller';
import type { WidgetAudioRuntime } from './controller';
import type { WidgetAudioApi } from './types';
import type { WidgetAudioState } from './protocol';
import { createFakeWorklet, flush } from './test-helpers';
import type { FakeWorklet } from './test-helpers';

const SESSION = 's1';

interface Harness {
  readonly runtime: WidgetAudioRuntime;
  readonly worklet: FakeWorklet;
  readonly api: WidgetAudioApi;
}

function createHarness(options: { state?: WidgetAudioState } = {}): Harness {
  const worklet = createFakeWorklet();
  const runtime = createWidgetAudioRuntime({});
  runtime.attachPort(worklet.port);
  runtime.open('i1', { state: options.state ?? 'running', session: SESSION });
  return { runtime, worklet, api: runtime.api('i1') };
}

describe('api.audio availability', () => {
  it('starts unavailable when the mount carried no audio', () => {
    const runtime = createWidgetAudioRuntime({});
    expect(runtime.api('i1').state).toBe('unavailable');
    runtime.dispose();
  });

  it('reports the state the mount carried and pushes later changes', () => {
    const { runtime, api } = createHarness({ state: 'suspended' });
    const seen: WidgetAudioState[] = [];
    api.onStateChange((next) => seen.push(next));

    expect(api.state).toBe('suspended');
    runtime.setState('running');
    expect(seen).toEqual(['running']);
    expect(api.state).toBe('running');
    runtime.dispose();
  });

  it('rejects listeners that are not functions', () => {
    const { runtime, api } = createHarness();
    expect(() =>
      api.onStateChange(undefined as unknown as (state: WidgetAudioState) => void),
    ).toThrow(TypeError);
    runtime.dispose();
  });
});

describe('tone commands', () => {
  it('validates options synchronously and forwards the tone', async () => {
    const { runtime, worklet, api } = createHarness();

    const tone = api.tone({ type: 'square', frequency: 440, volume: 0.5 });
    await flush();

    expect(worklet.callsOf('createTone')).toEqual([
      {
        member: 'createTone',
        args: [SESSION, { voiceId: tone.id, type: 'square', frequency: 440, volume: 0.5 }],
      },
    ]);
    expect(() => api.tone({ frequency: 0 })).toThrow(RangeError);
    expect(() => api.tone({ frequency: 440, volume: 2 })).toThrow(RangeError);
    expect(() => api.tone({ frequency: 440, type: 'noise' } as never)).toThrow(RangeError);
    expect(() => api.tone({ frequency: '440' } as never)).toThrow(TypeError);
    runtime.dispose();
  });

  it('forwards live updates with the ramp window', async () => {
    const { runtime, worklet, api } = createHarness();
    const tone = api.tone({ frequency: 440 });
    await flush();

    tone.set({ volume: 0.25, frequency: 880 }, { rampMs: 5 });
    await flush();
    expect(worklet.callsOf('setTone')).toEqual([
      { member: 'setTone', args: [SESSION, tone.id, { rampMs: 5, volume: 0.25, frequency: 880 }] },
    ]);
    expect(() => tone.set({ volume: 3 })).toThrow(RangeError);
    runtime.dispose();
  });

  it('settles stop locally and still tells the worklet', async () => {
    const { runtime, worklet, api } = createHarness();
    const tone = api.tone({ frequency: 440 });
    await flush();

    tone.stop();
    await expect(tone.ended).resolves.toEqual({ reason: 'stopped' });
    await flush();
    expect(worklet.callsOf('stopTone')).toEqual([
      { member: 'stopTone', args: [SESSION, tone.id, { fadeMs: 0 }] },
    ]);

    tone.set({ volume: 1 });
    await flush();
    expect(worklet.callsOf('setTone')).toHaveLength(0);
    runtime.dispose();
  });

  it('applies the reason the worklet reported', async () => {
    const { runtime, worklet, api } = createHarness();
    const tone = api.tone({ frequency: 440 });
    await flush();

    worklet.receivesEnded({ target: 'tone', id: tone.id, reason: 'dropped' });
    await expect(tone.ended).resolves.toEqual({ reason: 'dropped' });
    runtime.dispose();
  });

  it('drops the oldest tone once the guest ceiling is reached', async () => {
    const runtime = createWidgetAudioRuntime({ maxVoices: 2 });
    const worklet = createFakeWorklet();
    runtime.attachPort(worklet.port);
    runtime.open('i1', { state: 'running', session: SESSION });
    const api = runtime.api('i1');

    const first = api.tone({ frequency: 440 });
    api.tone({ frequency: 440 });
    api.tone({ frequency: 440 });
    await flush();

    await expect(first.ended).resolves.toEqual({ reason: 'dropped' });
    expect(worklet.callsOf('createTone')).toHaveLength(3);
    runtime.dispose();
  });
});

describe('PCM streams', () => {
  it('derives capacity and start frames from the millisecond options', async () => {
    const { runtime, worklet, api } = createHarness();
    const stream = api.createStream({
      sampleRate: 22050,
      channels: 1,
      format: 's16',
      bufferMs: 300,
      startMs: 40,
    });
    await flush();

    expect(stream.capacityFrames).toBe(6615);
    expect(stream.startFrames).toBe(882);
    expect(worklet.callsOf('createStream')).toEqual([
      {
        member: 'createStream',
        args: [
          SESSION,
          {
            streamId: stream.id,
            sampleRate: 22050,
            channels: 1,
            format: 's16',
            capacityFrames: 6615,
            startFrames: 882,
            volume: 1,
          },
        ],
      },
    ]);
    runtime.dispose();
  });

  it('applies the documented defaults', () => {
    const { runtime, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000 });
    expect(stream.channels).toBe(1);
    expect(stream.format).toBe('f32');
    expect(stream.volume).toBe(1);
    expect(stream.capacityFrames).toBe(24000);
    expect(stream.startFrames).toBe(2400);
    runtime.dispose();
  });

  it('validates the create options', () => {
    const { runtime, api } = createHarness();
    expect(() => api.createStream({ sampleRate: 1000 })).toThrow(RangeError);
    expect(() => api.createStream({ sampleRate: 44100.5 })).toThrow(RangeError);
    expect(() => api.createStream({ sampleRate: 44100, bufferMs: 10 })).toThrow(RangeError);
    expect(() => api.createStream({ sampleRate: 44100, startMs: 600, bufferMs: 500 })).toThrow(
      RangeError,
    );
    expect(() => api.createStream({ sampleRate: 44100, format: 'mp3' } as never)).toThrow(
      RangeError,
    );
    expect(() => api.createStream({ sampleRate: 44100, loop: true } as never)).toThrow(TypeError);
    runtime.dispose();
  });

  it('copies the block before transferring it to the worklet', async () => {
    const { runtime, worklet, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000 });

    const samples = new Float32Array([0.1, 0.2, 0.3]);
    await expect(stream.write(samples)).resolves.toBe(true);
    expect(samples.buffer.byteLength).toBe(12);
    expect(samples[0]).toBeCloseTo(0.1, 5);
    expect(Array.from(worklet.samples[0] ?? []).map((value) => Number(value.toFixed(5)))).toEqual([
      0.1, 0.2, 0.3,
    ]);
    runtime.dispose();
  });

  it('checks the block shape before anything is sent', async () => {
    const { runtime, worklet, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000, channels: 2, format: 's16' });

    expect(() => stream.write(new Float32Array(4) as unknown as Int16Array)).toThrow(TypeError);
    expect(() => stream.write(new Int16Array(0))).toThrow(RangeError);
    expect(() => stream.write(new Int16Array(3))).toThrow(RangeError);
    expect(() => stream.write(new Int16Array(stream.capacityFrames * 2 + 2))).toThrow(RangeError);
    await flush();
    expect(worklet.callsOf('writeStream')).toHaveLength(0);
    runtime.dispose();
  });

  it('reports a block the worklet refused as dropped', async () => {
    const { runtime, worklet, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000 });
    worklet.acceptWrites = false;

    await expect(stream.write(new Float32Array(4))).resolves.toBe(false);
    expect(stream.dropped).toBe(1);
    runtime.dispose();
  });

  it('drops a whole block when the local buffer lacks room', async () => {
    const { runtime, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000, bufferMs: 50 });
    const frames = stream.capacityFrames;

    await expect(stream.write(new Float32Array(frames))).resolves.toBe(true);
    await expect(stream.write(new Float32Array(2))).resolves.toBe(false);
    expect(stream.dropped).toBe(1);
    expect(stream.bufferedFrames).toBe(frames);
    runtime.dispose();
  });

  it('tracks credits, underruns and status from the worklet progress', async () => {
    const { runtime, worklet, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000, bufferMs: 50 });
    const statuses: unknown[] = [];
    stream.onStatus((status) => statuses.push(status));

    await stream.write(new Float32Array(stream.capacityFrames));
    worklet.receivesProgress({
      streamId: stream.id,
      consumedFrames: 100,
      underruns: 1,
      state: 'playing',
    });
    await flush();

    expect(stream.state).toBe('playing');
    expect(stream.underruns).toBe(1);
    expect(stream.bufferedFrames).toBe(stream.capacityFrames - 100);
    expect(statuses.at(-1)).toMatchObject({ state: 'playing', underruns: 1 });
    runtime.dispose();
  });

  it('fires onDrain at half capacity and re-arms after a refill', async () => {
    const { runtime, worklet, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000, bufferMs: 50 });
    const capacity = stream.capacityFrames;
    let drains = 0;
    stream.onDrain(() => {
      drains += 1;
    });

    await stream.write(new Float32Array(capacity));
    worklet.receivesProgress({
      streamId: stream.id,
      consumedFrames: capacity / 2,
      underruns: 0,
      state: 'playing',
    });
    await flush();
    expect(drains).toBe(1);

    worklet.receivesProgress({
      streamId: stream.id,
      consumedFrames: capacity / 4,
      underruns: 0,
      state: 'playing',
    });
    await flush();
    expect(drains).toBe(1);

    await stream.write(new Float32Array(capacity / 4));
    worklet.receivesProgress({
      streamId: stream.id,
      consumedFrames: (capacity * 3) / 4,
      underruns: 0,
      state: 'playing',
    });
    await flush();
    expect(drains).toBe(2);
    runtime.dispose();
  });

  it('ends with finished when the worklet confirms and with stopped on close', async () => {
    const { runtime, worklet, api } = createHarness();
    const ending = api.createStream({ sampleRate: 48000 });
    await flush();

    ending.end();
    await flush();
    expect(worklet.callsOf('endStream')).toHaveLength(1);
    worklet.receivesEnded({ target: 'stream', id: ending.id, reason: 'finished' });
    await expect(ending.ended).resolves.toEqual({ reason: 'finished' });
    expect(ending.state).toBe('ended');

    const closing = api.createStream({ sampleRate: 48000 });
    await flush();
    closing.close();
    await expect(closing.ended).resolves.toEqual({ reason: 'stopped' });
    await flush();
    expect(worklet.callsOf('closeStream')).toHaveLength(1);
    runtime.dispose();
  });

  it('closes the fifth stream on quota and keeps the handle usable', async () => {
    const { runtime, api } = createHarness();
    for (let index = 0; index < 4; index += 1) {
      api.createStream({ sampleRate: 48000 });
    }
    const extra = api.createStream({ sampleRate: 48000 });
    await expect(extra.ended).resolves.toEqual({ reason: 'stopped' });
    expect(extra.state).toBe('closed');
    await expect(extra.write(new Float32Array(4))).resolves.toBe(false);
    runtime.dispose();
  });

  it('refuses writes and settles locally while audio is unavailable', async () => {
    const { runtime, api } = createHarness({ state: 'unavailable' });
    const stream = api.createStream({ sampleRate: 48000 });
    await expect(stream.write(new Float32Array(4))).resolves.toBe(false);

    stream.end();
    await expect(stream.ended).resolves.toEqual({ reason: 'finished' });
    const tone = api.tone({ frequency: 440 });
    tone.stop();
    await expect(tone.ended).resolves.toEqual({ reason: 'stopped' });
    runtime.dispose();
  });
});

describe('instance teardown', () => {
  it('ends voices and streams with disposed', async () => {
    const { runtime, api } = createHarness();
    const tone = api.tone({ frequency: 440 });
    const stream = api.createStream({ sampleRate: 48000 });
    await flush();

    runtime.release('i1');
    await expect(tone.ended).resolves.toEqual({ reason: 'disposed' });
    await expect(stream.ended).resolves.toEqual({ reason: 'disposed' });
    runtime.dispose();
  });

  it('ignores worklet events after dispose', async () => {
    const { runtime, worklet, api } = createHarness();
    const stream = api.createStream({ sampleRate: 48000 });
    runtime.dispose();

    worklet.receivesEnded({ target: 'stream', id: stream.id, reason: 'finished' });
    await flush();
    expect(stream.state).toBe('closed');
  });
});
