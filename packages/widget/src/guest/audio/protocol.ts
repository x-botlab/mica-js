/**
 * Typed RPC contracts of the widget audio path (RFC 0016).
 *
 * Three endpoints carry the whole path:
 *
 * - the guest runtime talks to the `AudioWorklet` over a `MessagePort` it receives from the host;
 * - the host talks to the same worklet over the `AudioWorkletNode` port;
 * - the host pushes availability and the direct port into the guest over the sandbox RPC endpoint.
 *
 * `createRpc` serializes every call, so PCM stays on the worker ↔ worklet port and never passes
 * through the render host.
 */

import { defineRpcService } from '@mica-js/core/rpc';

/** Name the worklet registers its processor under. */
export const widgetAudioWorkletProcessor = 'mica-widget-audio';

/** Per-instance ceiling on simultaneous tones. */
export const defaultMaxVoices = 8;
/** Per-instance ceiling on open PCM streams. */
export const defaultMaxStreams = 4;

/** Availability of the host audio path. */
export type WidgetAudioState = 'unavailable' | 'suspended' | 'running';

/** Why a tone or stream stopped. */
export type WidgetAudioEndReason =
  'finished' | 'stopped' | 'dropped' | 'error' | 'unavailable' | 'disposed';

/** Sample layout of a PCM stream. */
export type WidgetAudioFormat = 's16' | 'f32';

/** Waveforms the worklet synthesizes for `api.audio.tone()`. */
export type WidgetOscillatorType = 'sine' | 'square' | 'triangle' | 'sawtooth';

/** Playback state of a PCM stream, as the guest sees it. */
export type WidgetAudioStreamState = 'buffering' | 'playing' | 'ended' | 'closed';

/** Per-instance ceilings; a host may tighten them through its options. */
export interface WidgetAudioLimits {
  readonly maxVoices: number;
  readonly maxStreams: number;
}

/** One mount generation of one instance, opened by the host before the guest can use it. */
export interface WidgetAudioSessionOpen {
  /** One-shot token every guest call must carry. */
  readonly session: string;
  /** Guest runtime that owns the token; a port from another runtime is rejected. */
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly maxVoices: number;
  readonly maxStreams: number;
}

export interface WidgetAudioToneInit {
  /** Guest-assigned id; unique per session. */
  readonly voiceId: string;
  readonly type: WidgetOscillatorType;
  /** Hz, `(0, 24000]`. */
  readonly frequency: number;
  /** `0`–`1`. */
  readonly volume: number;
}

export interface WidgetAudioToneSettings {
  readonly volume?: number;
  readonly frequency?: number;
  /** Smoothing window in milliseconds, `0`–`10000`. */
  readonly rampMs: number;
}

export interface WidgetAudioStop {
  /** Fade-out in milliseconds, `0`–`10000`. */
  readonly fadeMs: number;
}

export interface WidgetAudioStreamInit {
  /** Guest-assigned id; unique per session. */
  readonly streamId: string;
  /** Source rate in Hz, `8000`–`96000`. */
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly format: WidgetAudioFormat;
  readonly capacityFrames: number;
  readonly startFrames: number;
  readonly volume: number;
}

/** Answer of `createStream`: the worklet re-checks the per-session quota. */
export interface WidgetAudioStreamOpened {
  readonly accepted: boolean;
}

/** Credit report; `consumedFrames` is cumulative over the stream's lifetime. */
export interface WidgetAudioProgress {
  readonly streamId: string;
  readonly consumedFrames: number;
  readonly underruns: number;
  readonly state: WidgetAudioStreamState;
}

/** Terminal event of one tone or stream. */
export interface WidgetAudioEndedMessage {
  readonly target: 'tone' | 'stream';
  readonly id: string;
  readonly reason: WidgetAudioEndReason;
}

/** Diagnostic codes the audio path reports. */
export type WidgetAudioDiagnosticCode = 'widget/audio-failed' | 'widget/audio-limit';

/** Quota or validation class the receiving side dedupes against. */
export type WidgetAudioDiagnosticCategory = 'voices' | 'streams' | 'capacity' | 'worklet';

export interface WidgetAudioDiagnostic {
  /** Session the diagnostic belongs to; the host maps it back to the instance. */
  readonly session: string;
  readonly code: WidgetAudioDiagnosticCode;
  readonly category: WidgetAudioDiagnosticCategory;
  readonly message: string;
}

/**
 * Guest → worklet.
 *
 * Every member names a session; the worklet checks that the session belongs to the runtime that
 * owns the calling port, so a guest cannot steer another instance.
 */
export interface WidgetAudioWorkletService {
  createTone(session: string, init: WidgetAudioToneInit): void;
  setTone(session: string, voiceId: string, settings: WidgetAudioToneSettings): void;
  stopTone(session: string, voiceId: string, options: WidgetAudioStop): void;
  createStream(session: string, init: WidgetAudioStreamInit): WidgetAudioStreamOpened;
  /** `samples` travels as a transferred buffer; `true` means the whole block was accepted. */
  writeStream(session: string, streamId: string, samples: Int16Array | Float32Array): boolean;
  /** Drops everything that has not played yet and keeps the stream open. */
  clearStream(session: string, streamId: string): void;
  /** Drains the buffer, then ends the stream with `finished`. */
  endStream(session: string, streamId: string): void;
  /** Discards the buffer and closes the stream immediately. */
  closeStream(session: string, streamId: string): void;
  onDidProgress(listener: (progress: WidgetAudioProgress) => void): () => void;
  onDidEnded(listener: (ended: WidgetAudioEndedMessage) => void): () => void;
}

export const widgetAudioWorkletService =
  defineRpcService<WidgetAudioWorkletService>('audio-worklet');

/** Host → worklet, over the `AudioWorkletNode` port. */
export interface WidgetAudioControlService {
  openSession(init: WidgetAudioSessionOpen): void;
  closeSession(session: string): void;
  setSessionVolume(session: string, volume: number): void;
  setMuted(muted: boolean): void;
  suspend(): void;
  resume(): void;
  /** `port` is the guest end of the direct PCM channel; it is always transferred. */
  attachGuestPort(runtimeId: string, port: MessagePort): void;
  detachGuestPort(runtimeId: string): void;
  onDidDiagnostic(listener: (diagnostic: WidgetAudioDiagnostic) => void): () => void;
}

export const widgetAudioControlService =
  defineRpcService<WidgetAudioControlService>('audio-control');

/** Host → guest: audio availability and the direct PCM port handoff. */
export interface WidgetAudioGuestService {
  attachPort(port: MessagePort): void;
  setState(state: WidgetAudioState): void;
}

export const widgetAudioGuestService = defineRpcService<WidgetAudioGuestService>('audio-guest');

/** Attached to `mount` so the factory can read `api.audio.state` synchronously. */
export interface WidgetAudioMountInfo {
  readonly state: WidgetAudioState;
  /** One-shot token this mount generation uses on the direct port. */
  readonly session?: string;
}
