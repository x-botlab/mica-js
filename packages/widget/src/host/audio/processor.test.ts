import { describe, expect, it } from 'vitest';
import {
  createProcessorHarness,
  flush,
  makeSession,
  makeStream,
  TEST_SAMPLE_RATE,
} from './test-helpers';

describe('WidgetAudioProcessor', () => {
  it('mixes an accepted block into both output channels', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    expect(await guest.proxy.createStream('s1', makeStream('pcm'))).toEqual({ accepted: true });

    expect(await guest.proxy.writeStream('s1', 'pcm', new Float32Array(128).fill(0.5))).toBe(true);

    const { left, right } = harness.render(128);
    expect(left[100]).toBeCloseTo(0.5, 4);
    expect(right[100]).toBeCloseTo(0.5, 4);
    harness.dispose();
  });

  it('reports consumption credits to the guest', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm'));
    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(96).fill(1));

    harness.render(48);
    await flush();

    const last = guest.progress.at(-1);
    expect(last).toMatchObject({ streamId: 'pcm', state: 'playing' });
    expect(last?.consumedFrames).toBeGreaterThanOrEqual(48);
    harness.dispose();
  });

  it('drops a block beyond the capacity and reports the limit once', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm'));

    expect(await guest.proxy.writeStream('s1', 'pcm', new Float32Array(300))).toBe(true);
    expect(await guest.proxy.writeStream('s1', 'pcm', new Float32Array(300))).toBe(false);
    expect(await guest.proxy.writeStream('s1', 'pcm', new Float32Array(300))).toBe(false);
    await flush();

    const capacity = harness.diagnostics.filter((entry) => entry.category === 'capacity');
    expect(capacity).toHaveLength(1);
    expect(capacity[0]).toMatchObject({ code: 'widget/audio-limit', session: 's1' });
    harness.dispose();
  });

  it('waits for startFrames, then pads an underrun with silence', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm', { startFrames: 48 }));

    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(24).fill(1));
    expect(harness.render(24).left[0]).toBe(0);

    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(104).fill(1));
    expect(harness.render(128).left[100]).toBeCloseTo(1, 4);

    expect(harness.render(48).left[0]).toBe(0);
    await flush();
    expect(guest.progress.at(-1)).toMatchObject({ state: 'buffering', underruns: 1 });
    harness.dispose();
  });

  it('applies the session volume and the mute flag', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm'));
    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(384).fill(0.5));

    expect(harness.render(128).left[100]).toBeCloseTo(0.5, 4);
    await harness.control.setSessionVolume('s1', 0.5);
    expect(harness.render(128).left[100]).toBeCloseTo(0.25, 4);
    await harness.control.setMuted(true);
    expect(harness.render(128).left[100]).toBe(0);
    harness.dispose();
  });

  it('keeps buffered data while suspended and consumes on resume', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm'));
    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(128).fill(0.75));

    await harness.control.suspend();
    expect(harness.render(128).left[100]).toBe(0);
    await flush();
    expect(guest.progress).toHaveLength(0);

    await harness.control.resume();
    expect(harness.render(128).left[100]).toBeCloseTo(0.75, 4);
    harness.dispose();
  });

  it('drains the buffer before ending a stream', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream(
      's1',
      makeStream('pcm', { capacityFrames: 480, startFrames: 48 }),
    );
    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(384).fill(0.25));

    await guest.proxy.endStream('s1', 'pcm');
    await flush();
    expect(guest.ended).toHaveLength(0);

    const { left } = harness.render(400);
    // Index 150 is past the 2 ms fade-in and outside the end-of-stream fade-out.
    expect(left[150]).toBeCloseTo(0.25, 4);
    await flush();
    expect(guest.ended).toEqual([{ target: 'stream', id: 'pcm', reason: 'finished' }]);
    expect(guest.progress.at(-1)?.state).toBe('ended');
    harness.dispose();
  });

  it('discards the buffer when a stream is closed', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm'));
    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(128).fill(1));

    await guest.proxy.closeStream('s1', 'pcm');
    await flush();
    expect(guest.ended).toEqual([{ target: 'stream', id: 'pcm', reason: 'stopped' }]);
    expect(await guest.proxy.writeStream('s1', 'pcm', new Float32Array(48))).toBe(false);
    expect(harness.render(128).left[100]).toBe(0);
    harness.dispose();
  });

  it('clears the buffer but keeps the stream open', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm'));
    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(128).fill(1));

    await guest.proxy.clearStream('s1', 'pcm');
    expect(harness.render(128).left[100]).toBe(0);
    await flush();
    expect(guest.progress.at(-1)?.state).toBe('buffering');

    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(128).fill(0.5));
    expect(harness.render(128).left[100]).toBeCloseTo(0.5, 4);
    harness.dispose();
  });

  it('refuses a stream beyond the per-session quota', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));

    expect(await guest.proxy.createStream('s1', makeStream('a'))).toEqual({ accepted: true });
    expect(await guest.proxy.createStream('s1', makeStream('b'))).toEqual({ accepted: true });
    expect(await guest.proxy.createStream('s1', makeStream('c'))).toEqual({ accepted: false });
    await flush();
    expect(harness.diagnostics.filter((entry) => entry.category === 'streams')).toHaveLength(1);
    harness.dispose();
  });

  it('resamples a source rate that differs from the device rate', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream(
      's1',
      makeStream('pcm', { sampleRate: TEST_SAMPLE_RATE / 2, capacityFrames: 480, startFrames: 48 }),
    );
    await guest.proxy.writeStream('s1', 'pcm', new Float32Array(480).fill(0.5));

    const { left } = harness.render(128);
    // Half the source rate plays twice as long, at the same amplitude.
    expect(left[100]).toBeCloseTo(0.5, 3);
    harness.dispose();
  });

  it('converts s16 samples', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createStream('s1', makeStream('pcm', { format: 's16' }));
    await guest.proxy.writeStream('s1', 'pcm', new Int16Array(128).fill(16384));

    expect(harness.render(128).left[100]).toBeCloseTo(0.5, 4);
    harness.dispose();
  });

  it('rejects a guest call that names an unknown session', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await guest.proxy.createTone('missing', {
      voiceId: 't1',
      type: 'sine',
      frequency: 440,
      volume: 1,
    });
    await flush();
    expect(harness.diagnostics[0]).toMatchObject({
      code: 'widget/audio-failed',
      category: 'worklet',
      session: 'missing',
    });
    harness.dispose();
  });

  it('rejects a guest call from another runtime', async () => {
    const harness = createProcessorHarness();
    const first = await harness.guest('r1');
    const second = await harness.guest('r2');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await first.proxy.createStream('s1', makeStream('pcm'));

    expect(await second.proxy.writeStream('s1', 'pcm', new Float32Array(48))).toBe(false);
    await flush();
    expect(harness.diagnostics.at(-1)).toMatchObject({ category: 'worklet', session: 's1' });
    expect(await first.proxy.writeStream('s1', 'pcm', new Float32Array(48))).toBe(true);
    harness.dispose();
  });
});

describe('WidgetAudioProcessor tones', () => {
  it('synthesizes a tone and stops it', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createTone('s1', {
      voiceId: 't1',
      type: 'sine',
      frequency: 1000,
      volume: 1,
    });

    const { left } = harness.render(48);
    expect(Math.max(...left.map(Math.abs))).toBeGreaterThan(0.1);

    await guest.proxy.stopTone('s1', 't1', { fadeMs: 0 });
    await flush();
    expect(guest.ended).toEqual([{ target: 'tone', id: 't1', reason: 'stopped' }]);
    expect(harness.render(48).left[0]).toBe(0);
    harness.dispose();
  });

  it('fades a tone out over the requested window', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createTone('s1', {
      voiceId: 't1',
      type: 'square',
      frequency: 480,
      volume: 1,
    });
    harness.render(48);

    await guest.proxy.stopTone('s1', 't1', { fadeMs: 5 });
    const { left } = harness.render(480);
    expect(Math.abs(left[400] ?? 0)).toBeLessThan(0.1);
    await flush();
    expect(guest.ended).toEqual([{ target: 'tone', id: 't1', reason: 'stopped' }]);
    harness.dispose();
  });

  it('applies live parameter updates', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createTone('s1', {
      voiceId: 't1',
      type: 'sine',
      frequency: 1000,
      volume: 0.25,
    });
    expect(Math.max(...harness.render(48).left.map(Math.abs))).toBeLessThan(0.3);

    await guest.proxy.setTone('s1', 't1', { volume: 1, rampMs: 5 });
    const { left } = harness.render(480);
    // The 5 ms ramp is over well before the tail, so the tail reaches full volume.
    expect(Math.max(...left.slice(240).map(Math.abs))).toBeGreaterThan(0.9);
    harness.dispose();
  });

  it('drops the oldest tone beyond the ceiling and reports the limit once', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));

    for (let index = 0; index < 5; index += 1) {
      await guest.proxy.createTone('s1', {
        voiceId: `t${index}`,
        type: 'sine',
        frequency: 440,
        volume: 1,
      });
    }
    await flush();
    expect(guest.ended).toEqual([{ target: 'tone', id: 't0', reason: 'dropped' }]);
    expect(harness.diagnostics.filter((entry) => entry.category === 'voices')).toHaveLength(1);
    harness.dispose();
  });

  it('ends every tone and stream of a closed session', async () => {
    const harness = createProcessorHarness();
    const guest = await harness.guest('r1');
    await harness.control.openSession(makeSession('s1', 'r1'));
    await guest.proxy.createTone('s1', {
      voiceId: 't1',
      type: 'sine',
      frequency: 440,
      volume: 1,
    });
    await guest.proxy.createStream('s1', makeStream('pcm'));

    await harness.control.closeSession('s1');
    await flush();
    expect(guest.ended).toEqual(
      expect.arrayContaining([
        { target: 'tone', id: 't1', reason: 'stopped' },
        { target: 'stream', id: 'pcm', reason: 'stopped' },
      ]),
    );
    harness.dispose();
  });
});
