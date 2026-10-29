import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcPort } from '@mica-js/core/rpc';
import { widgetAudioControlService, widgetAudioWorkletService } from '../../guest/audio/protocol';
import type {
  WidgetAudioControlService,
  WidgetAudioDiagnostic,
  WidgetAudioDiagnosticCategory,
  WidgetAudioEndedMessage,
  WidgetAudioEndReason,
  WidgetAudioProgress,
  WidgetAudioSessionOpen,
  WidgetAudioStreamInit,
  WidgetAudioStreamOpened,
  WidgetAudioToneInit,
  WidgetAudioWorkletService,
} from '../../guest/audio/protocol';
import { FADE_SECONDS, PcmStream } from './stream';
import { ToneVoice } from './tone';

/** Largest buffer a guest may ask for: two seconds at the highest allowed rate. */
const MAX_CAPACITY_FRAMES = 96000 * 2;
/** Credit reports leave the worklet about this often. */
const PROGRESS_INTERVAL_SECONDS = 0.02;

const OSCILLATOR_TYPES: readonly string[] = ['sine', 'square', 'triangle', 'sawtooth'];

type ProgressListener = (progress: WidgetAudioProgress) => void;
type EndedListener = (ended: WidgetAudioEndedMessage) => void;

interface RuntimeLink {
  readonly id: string;
  readonly port: RpcPort;
  readonly endpoint: RpcEndpoint;
  readonly progress: Set<ProgressListener>;
  readonly ended: Set<EndedListener>;
  readonly registration: { dispose(): void };
}

interface SessionState {
  readonly session: string;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly maxVoices: number;
  readonly maxStreams: number;
  volume: number;
  readonly tones: Map<string, ToneVoice>;
  readonly streams: Map<string, PcmStream>;
}

export interface WidgetAudioProcessorOptions {
  /** Device rate of the owning worklet (`AudioWorkletGlobalScope.sampleRate`). */
  readonly sampleRate: number;
}

/**
 * The worklet half of the audio path (RFC 0016).
 *
 * Owns tone synthesis, PCM buffering, mixing, stream lifecycles, quotas and host controls. It is a
 * plain class so the node-side processor and the tests share one implementation: `AudioWorkletNode`
 * wiring lives in the worklet entry, everything else here.
 */
export class WidgetAudioProcessor {
  readonly #sampleRate: number;
  readonly #reportInterval: number;
  readonly #runtimes = new Map<string, RuntimeLink>();
  readonly #sessions = new Map<string, SessionState>();
  /** Dedupe tokens per session and category, dropped when the session closes. */
  readonly #reported = new Set<string>();
  readonly #diagnostics = new Set<(diagnostic: WidgetAudioDiagnostic) => void>();
  #host: RpcEndpoint | undefined;
  #muted = false;
  #suspended = false;
  #framesSinceReport = 0;
  #disposed = false;

  constructor(options: WidgetAudioProcessorOptions) {
    this.#sampleRate = options.sampleRate;
    this.#reportInterval = Math.max(1, Math.round(PROGRESS_INTERVAL_SECONDS * this.#sampleRate));
  }

  /** Registers the host control service on the `AudioWorkletNode` port. */
  attachHostPort(port: RpcPort): void {
    if (this.#disposed || this.#host !== undefined) return;
    const endpoint = createRpc(port);
    this.#host = endpoint;
    endpoint.register(widgetAudioControlService, this.#controlService());
  }

  /** Registers the guest service on a port the host transferred straight to the guest. */
  attachGuestPort(runtimeId: string, port: RpcPort): void {
    if (this.#disposed) return;
    this.detachGuestPort(runtimeId);
    const endpoint = createRpc(port);
    const progress = new Set<ProgressListener>();
    const ended = new Set<EndedListener>();
    const registration = endpoint.register(
      widgetAudioWorkletService,
      this.#guestService(runtimeId, { progress, ended }),
    );
    this.#runtimes.set(runtimeId, { id: runtimeId, port, endpoint, progress, ended, registration });
  }

  detachGuestPort(runtimeId: string): void {
    for (const [session, state] of [...this.#sessions]) {
      if (state.runtimeId === runtimeId) this.#closeSession(session, 'disposed');
    }
    const link = this.#runtimes.get(runtimeId);
    if (!link) return;
    this.#runtimes.delete(runtimeId);
    link.registration.dispose();
    link.endpoint.dispose();
    closePort(link.port);
  }

  /** Renders one quantum of every session into `outputs[0]`; the processor stays alive. */
  process(outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0 || this.#disposed) return true;
    for (const channel of output) channel.fill(0);
    if (this.#suspended || this.#sessions.size === 0) return true;

    const frames = output[0]?.length ?? 0;
    if (frames === 0) return true;
    const fadeFrames = Math.max(1, Math.round(this.#sampleRate * FADE_SECONDS));

    for (const state of [...this.#sessions.values()]) {
      // Mute only silences the output: consumption, credits and underruns keep running.
      const gain = this.#muted ? 0 : state.volume;
      for (const [voiceId, tone] of [...state.tones]) {
        tone.render(output, frames, gain);
        if (!tone.finished) continue;
        state.tones.delete(voiceId);
        this.#emitEnded(state, { target: 'tone', id: voiceId, reason: 'stopped' });
      }
      for (const [streamId, stream] of [...state.streams]) {
        stream.render(output, frames, gain, fadeFrames);
        if (stream.finished) {
          this.#finishStream(state, streamId, 'finished');
          continue;
        }
        if (stream.state !== stream.reportedState) {
          stream.reportedState = stream.state;
          this.#postProgress(state, stream);
        }
      }
    }

    this.#framesSinceReport += frames;
    if (this.#framesSinceReport >= this.#reportInterval) {
      this.#framesSinceReport = 0;
      for (const state of this.#sessions.values()) {
        for (const stream of state.streams.values()) this.#postProgress(state, stream);
      }
    }
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const session of [...this.#sessions.keys()]) this.#closeSession(session, 'disposed');
    for (const runtimeId of [...this.#runtimes.keys()]) this.detachGuestPort(runtimeId);
    this.#disposed = true;
    this.#diagnostics.clear();
    this.#host?.dispose();
    this.#host = undefined;
  }

  #controlService() {
    return {
      openSession: (init: WidgetAudioSessionOpen): void => this.#openSession(init),
      closeSession: (session: string): void => this.#closeSession(session, 'stopped'),
      setSessionVolume: (session: string, volume: number): void => {
        const state = this.#sessions.get(session);
        if (!state || typeof volume !== 'number' || !Number.isFinite(volume)) return;
        state.volume = Math.min(1, Math.max(0, volume));
      },
      setMuted: (muted: boolean): void => {
        this.#muted = muted === true;
      },
      suspend: (): void => {
        this.#suspended = true;
      },
      resume: (): void => {
        this.#suspended = false;
      },
      attachGuestPort: (runtimeId: string, port: MessagePort): void => {
        if (typeof runtimeId !== 'string' || runtimeId.length === 0) return;
        if (!isPort(port)) return;
        this.attachGuestPort(runtimeId, port);
      },
      detachGuestPort: (runtimeId: string): void => {
        if (typeof runtimeId !== 'string') return;
        this.detachGuestPort(runtimeId);
      },
      onDidDiagnostic: (listener: (diagnostic: WidgetAudioDiagnostic) => void): (() => void) => {
        if (typeof listener !== 'function') return () => {};
        this.#diagnostics.add(listener);
        return () => {
          this.#diagnostics.delete(listener);
        };
      },
    } satisfies WidgetAudioControlService;
  }

  #guestService(
    runtimeId: string,
    events: { readonly progress: Set<ProgressListener>; readonly ended: Set<EndedListener> },
  ): WidgetAudioWorkletService {
    return {
      createTone: (session, init) => {
        this.#createTone(runtimeId, session, init);
      },
      setTone: (session, voiceId, settings) => {
        const state = this.#session(runtimeId, session);
        const tone = state?.tones.get(voiceId);
        if (!state || !tone) return;
        if (!isToneSettings(settings)) {
          this.#diagnose(state.session, 'worklet', 'A tone update was rejected');
          return;
        }
        tone.set(settings);
      },
      stopTone: (session, voiceId, options) => {
        const state = this.#session(runtimeId, session);
        const tone = state?.tones.get(voiceId);
        if (!state || !tone) return;
        const fadeMs =
          typeof options === 'object' && options !== null && Number.isFinite(options.fadeMs)
            ? Math.min(10000, Math.max(0, options.fadeMs))
            : 0;
        tone.stop(fadeMs);
        if (tone.finished) {
          state.tones.delete(voiceId);
          this.#emitEnded(state, { target: 'tone', id: voiceId, reason: 'stopped' });
        }
      },
      createStream: (session, init) => this.#createStream(runtimeId, session, init),
      writeStream: (session, streamId, samples) => {
        const state = this.#session(runtimeId, session);
        const stream = state?.streams.get(streamId);
        if (!state || !stream) return false;
        const frames = readFrameCount(samples, stream.channels, stream.format);
        if (frames === undefined || frames > stream.capacityFrames) {
          this.#diagnose(state.session, 'worklet', 'A PCM block was rejected');
          return false;
        }
        if (stream.write(samples as Int16Array | Float32Array, frames)) return true;
        // Independent capacity check: the block is dropped whole, exactly like the guest did.
        this.#diagnose(
          state.session,
          'capacity',
          'A PCM block beyond the stream capacity was dropped',
        );
        return false;
      },
      clearStream: (session, streamId) => {
        const state = this.#session(runtimeId, session);
        const stream = state?.streams.get(streamId);
        if (!state || !stream) return;
        stream.clear();
        this.#postProgress(state, stream);
      },
      endStream: (session, streamId) => {
        const state = this.#session(runtimeId, session);
        const stream = state?.streams.get(streamId);
        if (!state || !stream) return;
        stream.endRequested = true;
        // A stream that already played everything ends right away; otherwise the render loop does.
        if (stream.consumed >= stream.buffer.written) {
          this.#finishStream(state, streamId, 'finished');
        }
      },
      closeStream: (session, streamId) => {
        const state = this.#session(runtimeId, session);
        if (!state?.streams.has(streamId)) return;
        this.#finishStream(state, streamId, 'stopped');
      },
      onDidProgress: (listener) => {
        if (typeof listener !== 'function') return () => {};
        events.progress.add(listener);
        return () => {
          events.progress.delete(listener);
        };
      },
      onDidEnded: (listener) => {
        if (typeof listener !== 'function') return () => {};
        events.ended.add(listener);
        return () => {
          events.ended.delete(listener);
        };
      },
    };
  }

  #openSession(init: WidgetAudioSessionOpen): void {
    if (!isSessionOpen(init) || this.#sessions.has(init.session)) return;
    if (!this.#runtimes.has(init.runtimeId)) {
      this.#diagnose(init.session, 'worklet', 'A session arrived before its guest port');
      return;
    }
    this.#sessions.set(init.session, {
      session: init.session,
      runtimeId: init.runtimeId,
      instanceId: init.instanceId,
      maxVoices: Math.max(1, Math.floor(init.maxVoices)),
      maxStreams: Math.max(1, Math.floor(init.maxStreams)),
      volume: 1,
      tones: new Map(),
      streams: new Map(),
    });
  }

  #createTone(runtimeId: string, session: string, init: WidgetAudioToneInit): void {
    const state = this.#session(runtimeId, session);
    if (!state) return;
    if (!isToneInit(init)) {
      this.#diagnose(state.session, 'worklet', 'A tone command was rejected');
      return;
    }
    if (state.tones.has(init.voiceId)) return;
    state.tones.set(init.voiceId, new ToneVoice(init.voiceId, init, this.#sampleRate));
    while (state.tones.size > state.maxVoices) {
      const oldest = state.tones.keys().next().value;
      if (oldest === undefined || oldest === init.voiceId) break;
      state.tones.delete(oldest);
      this.#emitEnded(state, { target: 'tone', id: oldest, reason: 'dropped' });
      this.#diagnose(
        state.session,
        'voices',
        `A tone was dropped: the per-instance ceiling of ${state.maxVoices} is exhausted`,
      );
    }
  }

  #createStream(
    runtimeId: string,
    session: string,
    init: WidgetAudioStreamInit,
  ): WidgetAudioStreamOpened {
    const state = this.#session(runtimeId, session);
    if (!state) return { accepted: false };
    if (!isStreamInit(init)) {
      this.#diagnose(state.session, 'worklet', 'A stream-open command was rejected');
      return { accepted: false };
    }
    if (state.streams.has(init.streamId)) return { accepted: true };
    if (state.streams.size >= state.maxStreams) {
      this.#diagnose(
        state.session,
        'streams',
        `A PCM stream was refused: the per-instance quota of ${state.maxStreams} is exhausted`,
      );
      return { accepted: false };
    }
    state.streams.set(init.streamId, new PcmStream(init, this.#sampleRate));
    return { accepted: true };
  }

  /** Looks up a session and checks the calling port owns it; the guest is untrusted. */
  #session(runtimeId: string, session: string): SessionState | undefined {
    if (typeof session !== 'string') return undefined;
    const state = this.#sessions.get(session);
    if (!state) {
      this.#diagnose(session, 'worklet', 'A guest call named an unknown session');
      return undefined;
    }
    if (state.runtimeId !== runtimeId) {
      this.#diagnose(session, 'worklet', 'A guest call came from another runtime');
      return undefined;
    }
    return state;
  }

  #closeSession(session: string, reason: 'stopped' | 'disposed'): void {
    const state = this.#sessions.get(session);
    if (!state) return;
    for (const voiceId of [...state.tones.keys()]) {
      state.tones.delete(voiceId);
      this.#emitEnded(state, { target: 'tone', id: voiceId, reason });
    }
    for (const streamId of [...state.streams.keys()]) {
      this.#finishStream(state, streamId, reason);
    }
    this.#sessions.delete(session);
    for (const key of [...this.#reported]) {
      if (key.startsWith(`${session}\u0000`)) this.#reported.delete(key);
    }
  }

  #finishStream(state: SessionState, streamId: string, reason: WidgetAudioEndReason): void {
    const stream = state.streams.get(streamId);
    if (!stream) return;
    stream.closed = true;
    stream.state = reason === 'finished' ? 'ended' : 'closed';
    state.streams.delete(streamId);
    this.#postProgress(state, stream);
    this.#emitEnded(state, { target: 'stream', id: streamId, reason });
  }

  #postProgress(state: SessionState, stream: PcmStream): void {
    const link = this.#runtimes.get(state.runtimeId);
    if (!link) return;
    const progress: WidgetAudioProgress = {
      streamId: stream.streamId,
      consumedFrames: stream.consumed,
      underruns: stream.underruns,
      state: stream.state,
    };
    for (const listener of [...link.progress]) {
      try {
        listener(progress);
      } catch {
        // A broken subscriber must not interrupt rendering.
      }
    }
  }

  #emitEnded(state: SessionState, ended: WidgetAudioEndedMessage): void {
    const link = this.#runtimes.get(state.runtimeId);
    if (!link) return;
    for (const listener of [...link.ended]) {
      try {
        listener(ended);
      } catch {
        // A broken subscriber must not interrupt rendering.
      }
    }
  }

  #diagnose(session: string, category: WidgetAudioDiagnosticCategory, message: string): void {
    const key = `${session}\u0000${category}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    const diagnostic: WidgetAudioDiagnostic = {
      session,
      code: category === 'worklet' ? 'widget/audio-failed' : 'widget/audio-limit',
      category,
      message,
    };
    for (const listener of [...this.#diagnostics]) {
      try {
        listener(diagnostic);
      } catch {
        // Reporting must never interrupt the audio path.
      }
    }
  }
}

function isPort(value: unknown): value is RpcPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RpcPort).postMessage === 'function' &&
    typeof (value as RpcPort).addEventListener === 'function'
  );
}

function closePort(port: RpcPort): void {
  try {
    (port as { close?: () => void }).close?.();
  } catch {
    // Already closed.
  }
}

function isSessionOpen(value: unknown): value is WidgetAudioSessionOpen {
  if (typeof value !== 'object' || value === null) return false;
  const init = value as Record<string, unknown>;
  return (
    typeof init['session'] === 'string' &&
    init['session'].length > 0 &&
    typeof init['runtimeId'] === 'string' &&
    init['runtimeId'].length > 0 &&
    typeof init['instanceId'] === 'string' &&
    typeof init['maxVoices'] === 'number' &&
    Number.isFinite(init['maxVoices']) &&
    typeof init['maxStreams'] === 'number' &&
    Number.isFinite(init['maxStreams'])
  );
}

function isToneInit(value: unknown): value is WidgetAudioToneInit {
  if (typeof value !== 'object' || value === null) return false;
  const init = value as Record<string, unknown>;
  const frequency = init['frequency'];
  const volume = init['volume'];
  return (
    typeof init['voiceId'] === 'string' &&
    init['voiceId'].length > 0 &&
    typeof init['type'] === 'string' &&
    OSCILLATOR_TYPES.includes(init['type']) &&
    typeof frequency === 'number' &&
    Number.isFinite(frequency) &&
    frequency > 0 &&
    frequency <= 24000 &&
    typeof volume === 'number' &&
    Number.isFinite(volume) &&
    volume >= 0 &&
    volume <= 1
  );
}

function isToneSettings(
  value: unknown,
): value is { volume?: number; frequency?: number; rampMs: number } {
  if (typeof value !== 'object' || value === null) return false;
  const settings = value as Record<string, unknown>;
  const rampMs = settings['rampMs'];
  if (typeof rampMs !== 'number' || !Number.isFinite(rampMs) || rampMs < 0 || rampMs > 10000) {
    return false;
  }
  const volume = settings['volume'];
  if (
    volume !== undefined &&
    (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1)
  ) {
    return false;
  }
  const frequency = settings['frequency'];
  if (
    frequency !== undefined &&
    (typeof frequency !== 'number' ||
      !Number.isFinite(frequency) ||
      frequency <= 0 ||
      frequency > 24000)
  ) {
    return false;
  }
  return true;
}

function isStreamInit(value: unknown): value is WidgetAudioStreamInit {
  if (typeof value !== 'object' || value === null) return false;
  const init = value as Record<string, unknown>;
  const sampleRate = init['sampleRate'];
  const capacityFrames = init['capacityFrames'];
  const startFrames = init['startFrames'];
  const volume = init['volume'];
  return (
    typeof init['streamId'] === 'string' &&
    init['streamId'].length > 0 &&
    typeof sampleRate === 'number' &&
    Number.isInteger(sampleRate) &&
    sampleRate >= 8000 &&
    sampleRate <= 96000 &&
    (init['channels'] === 1 || init['channels'] === 2) &&
    (init['format'] === 's16' || init['format'] === 'f32') &&
    typeof capacityFrames === 'number' &&
    Number.isInteger(capacityFrames) &&
    capacityFrames >= 1 &&
    capacityFrames <= MAX_CAPACITY_FRAMES &&
    typeof startFrames === 'number' &&
    Number.isInteger(startFrames) &&
    startFrames >= 0 &&
    startFrames <= capacityFrames &&
    typeof volume === 'number' &&
    Number.isFinite(volume)
  );
}

/** Frames of one block, or `undefined` when the block does not match the stream layout. */
function readFrameCount(
  samples: unknown,
  channels: number,
  format: 's16' | 'f32',
): number | undefined {
  const expected = format === 's16' ? Int16Array : Float32Array;
  if (!(samples instanceof expected) || samples.length === 0) return undefined;
  if (samples.length % channels !== 0) return undefined;
  return samples.length / channels;
}
