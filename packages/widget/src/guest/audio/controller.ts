import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint, RpcPort, RpcProxy } from '@mica-js/core/rpc';
import { defaultMaxStreams, defaultMaxVoices, widgetAudioWorkletService } from './protocol';
import type {
  WidgetAudioEndedMessage,
  WidgetAudioEndReason,
  WidgetAudioMountInfo,
  WidgetAudioProgress,
  WidgetAudioState,
  WidgetAudioStreamState,
  WidgetAudioWorkletService,
} from './protocol';
import type {
  WidgetAudioApi,
  WidgetAudioEnded,
  WidgetAudioFormat,
  WidgetAudioStream,
  WidgetAudioStreamStatus,
  WidgetAudioTone,
  WidgetAudioVoice,
} from './types';
import {
  AUDIO_FORMATS,
  BUFFER_MS,
  FREQUENCY_RANGE,
  OSCILLATOR_TYPES,
  RAMP_MS,
  SAMPLE_RATES,
  VOLUME_RANGE,
  readEnum,
  readOptionalRangedNumber,
  readOptions,
  readRangedNumber,
  requireListener,
} from './validate';

export interface WidgetAudioRuntimeOptions {
  /** Guest-side callback failures surface as `widget/deliver-failed`, like every other callback. */
  readonly onListenerError?: (instanceId: string, error: unknown) => void;
  readonly maxVoices?: number;
  readonly maxStreams?: number;
}

/** Guest-side audio state shared by every instance of one sandbox. */
export interface WidgetAudioRuntime {
  readonly state: WidgetAudioState;
  /** API for one instance; the same object is returned on every call. */
  api(instanceId: string): WidgetAudioApi;
  /** Applies the state and mount token the host sent with `mount`. */
  open(instanceId: string, info: WidgetAudioMountInfo | undefined): void;
  setState(state: WidgetAudioState): void;
  /** Takes the direct worker ↔ worklet port; every audio call rides on its RPC endpoint. */
  attachPort(port: RpcPort): void;
  /** Instance teardown: every handle ends with `disposed`. */
  release(instanceId: string): void;
  dispose(): void;
}

interface VoiceRecord {
  readonly id: string;
  readonly instanceId: string;
  /** A voice that never reached the worklet (audio unavailable); `set`/`stop` stay local. */
  readonly dead: boolean;
  settled: boolean;
  readonly ended: Promise<WidgetAudioEnded>;
  readonly resolve: (ended: WidgetAudioEnded) => void;
}

interface StreamRecord {
  readonly id: string;
  readonly instanceId: string;
  readonly session: string | undefined;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly format: WidgetAudioFormat;
  readonly capacityFrames: number;
  readonly startFrames: number;
  readonly volume: number;
  /** No worklet path: writes are refused and `end()` completes locally. */
  readonly unavailable: boolean;
  /** Frames the worklet accepted. */
  writtenFrames: number;
  /** Frames sent and awaiting the worklet's answer; counted as buffered but not yet accepted. */
  pendingFrames: number;
  consumedFrames: number;
  underruns: number;
  dropped: number;
  state: WidgetAudioStreamState;
  drainNotified: boolean;
  endRequested: boolean;
  closed: boolean;
  settled: boolean;
  readonly ended: Promise<WidgetAudioEnded>;
  readonly resolve: (ended: WidgetAudioEnded) => void;
  readonly statusListeners: Set<(status: WidgetAudioStreamStatus) => void>;
  readonly drainListeners: Set<() => void>;
}

interface InstanceRecord {
  readonly instanceId: string;
  session: string | undefined;
  state: WidgetAudioState;
  readonly stateListeners: Set<(state: WidgetAudioState) => void>;
  readonly voices: Map<string, VoiceRecord>;
  readonly streams: Map<string, StreamRecord>;
  api: WidgetAudioApi;
}

const AUDIO_STATES: readonly WidgetAudioState[] = ['unavailable', 'suspended', 'running'];
const STREAM_STATES: readonly WidgetAudioStreamState[] = [
  'buffering',
  'playing',
  'ended',
  'closed',
];
const END_REASONS: readonly WidgetAudioEndReason[] = [
  'finished',
  'stopped',
  'dropped',
  'error',
  'unavailable',
  'disposed',
];

function deferredSettlement(): {
  readonly promise: Promise<WidgetAudioEnded>;
  readonly resolve: (ended: WidgetAudioEnded) => void;
} {
  let resolve: (ended: WidgetAudioEnded) => void = () => {};
  const promise = new Promise<WidgetAudioEnded>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Creates the guest half of the audio path; one per sandbox runtime.
 *
 * The guest owns the public handles and their synchronous validation. Everything that makes sound
 * happens in the worklet, reached over the port the host transfers in: this module only mirrors the
 * worklet's answers, credits and terminal events.
 */
export function createWidgetAudioRuntime(options: WidgetAudioRuntimeOptions): WidgetAudioRuntime {
  const maxVoices = options.maxVoices ?? defaultMaxVoices;
  const maxStreams = options.maxStreams ?? defaultMaxStreams;
  const instances = new Map<string, InstanceRecord>();
  /** Lookups for worklet events, which only carry an id. */
  const voiceIndex = new Map<string, VoiceRecord>();
  const streamIndex = new Map<string, StreamRecord>();
  let endpoint: RpcEndpoint | undefined;
  let proxy: RpcProxy<WidgetAudioWorkletService> | undefined;
  /** Resolves once the direct port arrived, or immediately when the runtime is disposed. */
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let state: WidgetAudioState = 'unavailable';
  let disposed = false;
  let voiceCounter = 0;
  let streamCounter = 0;

  function reportListenerError(instanceId: string, error: unknown): void {
    try {
      options.onListenerError?.(instanceId, error);
    } catch {
      // Nothing left to report to.
    }
  }

  function worklet(): Promise<RpcProxy<WidgetAudioWorkletService> | undefined> {
    return ready.then(() => (disposed ? undefined : proxy));
  }

  function createInstance(instanceId: string): InstanceRecord {
    const instance: InstanceRecord = {
      instanceId,
      session: undefined,
      state,
      stateListeners: new Set(),
      voices: new Map(),
      streams: new Map(),
      api: undefined as unknown as WidgetAudioApi,
    };
    instance.api = createApi(instance);
    return instance;
  }

  function requireInstance(instanceId: string): InstanceRecord {
    let instance = instances.get(instanceId);
    if (!instance) {
      instance = createInstance(instanceId);
      instances.set(instanceId, instance);
    }
    return instance;
  }

  function finishVoice(voice: VoiceRecord, reason: WidgetAudioEndReason): void {
    if (voice.settled) return;
    voice.settled = true;
    voiceIndex.delete(voice.id);
    instances.get(voice.instanceId)?.voices.delete(voice.id);
    voice.resolve({ reason });
  }

  function finishStream(stream: StreamRecord, reason: WidgetAudioEndReason): void {
    if (stream.settled) return;
    stream.closed = true;
    stream.state = reason === 'finished' ? 'ended' : 'closed';
    streamIndex.delete(stream.id);
    instances.get(stream.instanceId)?.streams.delete(stream.id);
    notifyStatus(stream);
    stream.settled = true;
    stream.resolve({ reason });
  }

  function bufferedFrames(stream: StreamRecord): number {
    return Math.max(0, stream.writtenFrames + stream.pendingFrames - stream.consumedFrames);
  }

  function snapshot(stream: StreamRecord): WidgetAudioStreamStatus {
    return {
      state: stream.state,
      underruns: stream.underruns,
      dropped: stream.dropped,
      bufferedFrames: bufferedFrames(stream),
      capacityFrames: stream.capacityFrames,
    };
  }

  function notifyStatus(stream: StreamRecord): void {
    if (stream.statusListeners.size === 0) return;
    const status = snapshot(stream);
    for (const listener of [...stream.statusListeners]) {
      try {
        listener(status);
      } catch (error) {
        reportListenerError(stream.instanceId, error);
      }
    }
  }

  function notifyDrain(stream: StreamRecord): void {
    for (const listener of [...stream.drainListeners]) {
      try {
        listener();
      } catch (error) {
        reportListenerError(stream.instanceId, error);
      }
    }
  }

  /** Fires `onDrain` once each time the buffer falls to half its capacity. */
  function checkDrain(stream: StreamRecord): void {
    if (stream.closed) return;
    const half = stream.capacityFrames / 2;
    if (stream.drainNotified) {
      if (bufferedFrames(stream) > half) stream.drainNotified = false;
      return;
    }
    if (bufferedFrames(stream) > half) return;
    stream.drainNotified = true;
    notifyDrain(stream);
  }

  function updateState(next: WidgetAudioState): void {
    if (state === next) return;
    state = next;
    for (const instance of instances.values()) {
      if (instance.state === next) continue;
      instance.state = next;
      for (const listener of [...instance.stateListeners]) {
        try {
          listener(next);
        } catch (error) {
          reportListenerError(instance.instanceId, error);
        }
      }
    }
  }

  function addVoice(instance: InstanceRecord, dead: boolean): VoiceRecord {
    voiceCounter += 1;
    const { promise, resolve } = deferredSettlement();
    const voice: VoiceRecord = {
      id: `t${voiceCounter}`,
      instanceId: instance.instanceId,
      dead,
      settled: false,
      ended: promise,
      resolve,
    };

    // Guest-side quota is advisory: the worklet enforces the same ceiling independently.
    if (instance.voices.size >= maxVoices) {
      const oldest = instance.voices.values().next().value;
      if (oldest !== undefined) finishVoice(oldest, 'dropped');
    }
    instance.voices.set(voice.id, voice);
    voiceIndex.set(voice.id, voice);
    return voice;
  }

  function voiceHandle(voice: VoiceRecord): WidgetAudioVoice {
    return {
      id: voice.id,
      ended: voice.ended,
      stop(): void {
        if (voice.settled) return;
        if (!voice.dead) {
          const session = instances.get(voice.instanceId)?.session;
          if (session !== undefined) {
            void worklet()
              .then((service) => service?.stopTone(session, voice.id, { fadeMs: 0 }))
              .catch(() => undefined);
          }
        }
        finishVoice(voice, 'stopped');
      },
    };
  }

  function createApi(instance: InstanceRecord): WidgetAudioApi {
    return {
      get state() {
        return instance.state;
      },

      onStateChange(listener: (next: WidgetAudioState) => void) {
        requireListener(listener, 'api.audio.onStateChange(listener)');
        instance.stateListeners.add(listener);
        return () => {
          instance.stateListeners.delete(listener);
        };
      },

      tone(toneOptions) {
        const settings = readOptions(toneOptions, ['type', 'frequency', 'volume'], 'options');
        const type = readEnum(settings, 'type', OSCILLATOR_TYPES, 'options', 'sine');
        const frequency = readRangedNumber(settings, 'frequency', 'options', {
          ...FREQUENCY_RANGE,
          exclusiveMin: true,
        });
        const volume = readRangedNumber(settings, 'volume', 'options', VOLUME_RANGE, 1);
        const session = instance.session;
        const voice = addVoice(instance, instance.state === 'unavailable' || session === undefined);

        if (!voice.dead && session !== undefined) {
          void worklet()
            .then((service) =>
              service?.createTone(session, { voiceId: voice.id, type, frequency, volume }),
            )
            .catch(() => undefined);
        }

        return Object.assign(voiceHandle(voice), {
          set(next: Parameters<WidgetAudioTone['set']>[0], rampOptions?: { rampMs?: number }) {
            const params = readOptions(next, ['volume', 'frequency'], 'options');
            const rampSettings = readOptions(rampOptions, ['rampMs'], 'options');
            const rampMs = readRangedNumber(rampSettings, 'rampMs', 'options', RAMP_MS, 0);
            const nextVolume = readOptionalRangedNumber(params, 'volume', 'options', VOLUME_RANGE);
            const nextFrequency = readOptionalRangedNumber(params, 'frequency', 'options', {
              ...FREQUENCY_RANGE,
              exclusiveMin: true,
            });
            if (voice.settled || voice.dead || session === undefined) return;
            void worklet()
              .then((service) =>
                service?.setTone(session, voice.id, {
                  rampMs,
                  ...(nextVolume === undefined ? {} : { volume: nextVolume }),
                  ...(nextFrequency === undefined ? {} : { frequency: nextFrequency }),
                }),
              )
              .catch(() => undefined);
          },
        }) satisfies WidgetAudioTone;
      },

      createStream(streamOptions) {
        const settings = readOptions(
          streamOptions,
          ['sampleRate', 'channels', 'format', 'bufferMs', 'startMs', 'volume'],
          'options',
        );
        const sampleRate = readRangedNumber(settings, 'sampleRate', 'options', {
          ...SAMPLE_RATES,
          integer: true,
        });
        const channels = readEnum(settings, 'channels', [1, 2] as const, 'options', 1);
        const format = readEnum(settings, 'format', AUDIO_FORMATS, 'options', 'f32');
        const bufferMs = readRangedNumber(settings, 'bufferMs', 'options', BUFFER_MS, 500);
        const startMs = readRangedNumber(
          settings,
          'startMs',
          'options',
          { min: 0, max: bufferMs },
          50,
        );
        const volume = readRangedNumber(settings, 'volume', 'options', VOLUME_RANGE, 1);

        const capacityFrames = Math.max(1, Math.ceil((bufferMs * sampleRate) / 1000));
        const startFrames = Math.min(
          capacityFrames,
          Math.max(0, Math.ceil((startMs * sampleRate) / 1000)),
        );
        streamCounter += 1;

        const overQuota = instance.streams.size >= maxStreams;
        const unavailable = instance.state === 'unavailable' || instance.session === undefined;
        const { promise, resolve } = deferredSettlement();
        const stream: StreamRecord = {
          id: `s${streamCounter}`,
          instanceId: instance.instanceId,
          session: instance.session,
          sampleRate,
          channels,
          format,
          capacityFrames,
          startFrames,
          volume,
          unavailable,
          writtenFrames: 0,
          pendingFrames: 0,
          consumedFrames: 0,
          underruns: 0,
          dropped: 0,
          state: overQuota ? 'closed' : 'buffering',
          drainNotified: false,
          endRequested: false,
          closed: overQuota,
          settled: overQuota,
          ended: promise,
          resolve,
          statusListeners: new Set(),
          drainListeners: new Set(),
        };

        if (overQuota) {
          // The handle stays usable so a widget does not have to special-case the failure; the
          // worklet reports `widget/audio-limit` for the streams it refuses as well.
          resolve({ reason: 'stopped' });
        } else {
          instance.streams.set(stream.id, stream);
          streamIndex.set(stream.id, stream);
          if (!unavailable && instance.session !== undefined) {
            const session = instance.session;
            void worklet()
              .then((service) =>
                service?.createStream(session, {
                  streamId: stream.id,
                  sampleRate,
                  channels,
                  format,
                  capacityFrames,
                  startFrames,
                  volume,
                }),
              )
              .then((opened) => {
                if (opened?.accepted === false) finishStream(stream, 'stopped');
              })
              .catch(() => undefined);
          }
        }

        return createStreamHandle(stream);
      },
    } satisfies WidgetAudioApi;
  }

  function createStreamHandle(stream: StreamRecord): WidgetAudioStream {
    return {
      id: stream.id,
      sampleRate: stream.sampleRate,
      channels: stream.channels,
      format: stream.format,
      capacityFrames: stream.capacityFrames,
      startFrames: stream.startFrames,
      volume: stream.volume,
      get bufferedFrames() {
        return bufferedFrames(stream);
      },
      get underruns() {
        return stream.underruns;
      },
      get dropped() {
        return stream.dropped;
      },
      get state() {
        return stream.state;
      },
      ended: stream.ended,

      write(samples: Int16Array | Float32Array): Promise<boolean> {
        if (stream.closed) return Promise.resolve(false);
        const expected = stream.format === 's16' ? Int16Array : Float32Array;
        if (!(samples instanceof expected)) {
          throw new TypeError(
            `api.audio stream.write expects a ${expected.name} for format "${stream.format}"`,
          );
        }
        const length = samples.length;
        if (length === 0) {
          throw new RangeError('api.audio stream.write expects at least one sample');
        }
        if (length % stream.channels !== 0) {
          throw new RangeError(
            `api.audio stream.write expects a whole number of ${stream.channels}-channel frames`,
          );
        }
        const frames = length / stream.channels;
        if (frames > stream.capacityFrames) {
          throw new RangeError(
            `api.audio stream.write accepts at most ${stream.capacityFrames} frames per call`,
          );
        }
        if (stream.unavailable) return Promise.resolve(false);
        if (bufferedFrames(stream) + frames > stream.capacityFrames) {
          stream.dropped += 1;
          notifyStatus(stream);
          return Promise.resolve(false);
        }

        // The caller keeps ownership of `samples`: this copy is the only one before the buffer is
        // transferred to the worklet.
        const copy = stream.format === 's16' ? new Int16Array(samples) : new Float32Array(samples);
        const session = stream.session ?? '';
        stream.pendingFrames += frames;
        return worklet().then(async (service) => {
          if (service === undefined || stream.closed) {
            stream.pendingFrames -= frames;
            return false;
          }
          try {
            const accepted = await service.writeStream(session, stream.id, copy);
            stream.pendingFrames -= frames;
            if (accepted) stream.writtenFrames += frames;
            else stream.dropped += 1;
            notifyStatus(stream);
            checkDrain(stream);
            return accepted;
          } catch {
            stream.pendingFrames -= frames;
            return false;
          }
        });
      },

      clear(): void {
        if (stream.closed) return;
        stream.consumedFrames = stream.writtenFrames;
        if (!stream.unavailable && stream.session !== undefined) {
          const session = stream.session;
          void worklet()
            .then((service) => service?.clearStream(session, stream.id))
            .catch(() => undefined);
        }
        notifyStatus(stream);
        checkDrain(stream);
      },

      end(): void {
        if (stream.closed || stream.endRequested) return;
        stream.endRequested = true;
        if (stream.unavailable || stream.session === undefined) {
          finishStream(stream, 'finished');
          return;
        }
        const session = stream.session;
        void worklet()
          .then((service) => service?.endStream(session, stream.id))
          .catch(() => undefined);
      },

      close(): void {
        if (stream.settled) return;
        if (!stream.closed && !stream.unavailable && stream.session !== undefined) {
          const session = stream.session;
          void worklet()
            .then((service) => service?.closeStream(session, stream.id))
            .catch(() => undefined);
        }
        finishStream(stream, 'stopped');
      },

      onDrain(listener: () => void): () => void {
        requireListener(listener, 'api.audio stream.onDrain(listener)');
        stream.drainListeners.add(listener);
        return () => {
          stream.drainListeners.delete(listener);
        };
      },

      onStatus(listener: (status: WidgetAudioStreamStatus) => void): () => void {
        requireListener(listener, 'api.audio stream.onStatus(listener)');
        stream.statusListeners.add(listener);
        return () => {
          stream.statusListeners.delete(listener);
        };
      },
    };
  }

  function applyProgress(progress: WidgetAudioProgress): void {
    if (typeof progress !== 'object' || progress === null) return;
    if (typeof progress.streamId !== 'string') return;
    const stream = streamIndex.get(progress.streamId);
    if (!stream) return;

    if (typeof progress.consumedFrames === 'number' && Number.isFinite(progress.consumedFrames)) {
      // Credit only moves forward: a report that crosses a `clear()` must not reopen the buffer.
      stream.consumedFrames = Math.max(stream.consumedFrames, Math.floor(progress.consumedFrames));
    }
    if (typeof progress.underruns === 'number' && Number.isFinite(progress.underruns)) {
      stream.underruns = Math.max(0, Math.floor(progress.underruns));
    }
    if (!stream.closed && STREAM_STATES.includes(progress.state)) {
      stream.state = progress.state;
    }
    notifyStatus(stream);
    checkDrain(stream);
  }

  function applyEnded(ended: WidgetAudioEndedMessage): void {
    if (typeof ended !== 'object' || ended === null || typeof ended.id !== 'string') return;
    const reason = END_REASONS.includes(ended.reason) ? ended.reason : 'stopped';
    if (ended.target === 'tone') {
      const voice = voiceIndex.get(ended.id);
      if (voice) finishVoice(voice, reason);
      return;
    }
    const stream = streamIndex.get(ended.id);
    if (stream) finishStream(stream, reason);
  }

  function release(instanceId: string): void {
    const instance = instances.get(instanceId);
    if (!instance) return;
    instances.delete(instanceId);
    for (const voice of instance.voices.values()) {
      finishVoice(voice, 'disposed');
    }
    instance.voices.clear();
    for (const stream of [...instance.streams.values()]) {
      finishStream(stream, 'disposed');
    }
    instance.streams.clear();
    instance.stateListeners.clear();
  }

  return {
    get state() {
      return state;
    },

    api(instanceId) {
      return requireInstance(instanceId).api;
    },

    open(instanceId, info) {
      const instance = requireInstance(instanceId);
      instance.session = info?.session;
      if (info === undefined) return;
      instance.state = info.state;
      state = info.state;
    },

    setState(next) {
      if (!AUDIO_STATES.includes(next)) return;
      updateState(next);
    },

    attachPort(port) {
      if (disposed || endpoint !== undefined) return;
      const created = createRpc(port);
      endpoint = created;
      proxy = created.getProxy(widgetAudioWorkletService, {
        transfer: (member, args) =>
          member === 'writeStream' && isSamples(args[2]) ? [args[2].buffer] : [],
      });
      proxy.onDidProgress((progress) => applyProgress(progress));
      proxy.onDidEnded((ended) => applyEnded(ended));
      resolveReady();
    },

    release,

    dispose() {
      if (disposed) return;
      for (const instanceId of [...instances.keys()]) {
        release(instanceId);
      }
      disposed = true;
      resolveReady();
      endpoint?.dispose();
      endpoint = undefined;
      proxy = undefined;
      voiceIndex.clear();
      streamIndex.clear();
    },
  };
}

function isSamples(value: unknown): value is Int16Array | Float32Array {
  return value instanceof Int16Array || value instanceof Float32Array;
}
