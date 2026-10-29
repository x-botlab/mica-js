import type {
  WidgetAudioEndReason,
  WidgetAudioFormat,
  WidgetAudioState,
  WidgetAudioStreamState,
  WidgetOscillatorType,
} from './protocol';

/** Reason a voice or stream reached its end. */
export type { WidgetAudioEndReason, WidgetAudioFormat, WidgetAudioState } from './protocol';
export type { WidgetAudioStreamState, WidgetOscillatorType } from './protocol';

export interface WidgetAudioEnded {
  readonly reason: WidgetAudioEndReason;
}

export interface WidgetAudioToneOptions {
  /** `sine` when omitted. */
  readonly type?: WidgetOscillatorType;
  /** Hz, `(0, 24000]`. */
  readonly frequency: number;
  /** `0`–`1`; `1` when omitted. */
  readonly volume?: number;
}

export interface WidgetAudioVoiceSettings {
  readonly volume?: number;
  readonly frequency?: number;
}

export interface WidgetAudioRampOptions {
  /** Smoothing window in milliseconds, `0`–`10000`; `0` when omitted. */
  readonly rampMs?: number;
}

export interface WidgetAudioStopOptions {
  /** Fade-out in milliseconds, `0`–`10000`; `0` when omitted. */
  readonly fadeMs?: number;
}

/** Handle for one voice; closing it is idempotent. */
export interface WidgetAudioVoice {
  readonly id: string;
  /** Settles once the worklet (or the guest, when audio is unavailable) stopped the voice. */
  readonly ended: Promise<WidgetAudioEnded>;
  stop(options?: WidgetAudioStopOptions): void;
}

/** Voice handle of a continuous oscillator, with live parameter updates. */
export interface WidgetAudioTone extends WidgetAudioVoice {
  set(settings: WidgetAudioVoiceSettings, options?: WidgetAudioRampOptions): void;
}

export interface WidgetAudioStreamOptions {
  /** Integer source rate in Hz, `8000`–`96000`; required. */
  readonly sampleRate: number;
  /** `1` (default) or `2`; multi-channel samples are interleaved. */
  readonly channels?: 1 | 2;
  /** `f32` (default) or `s16`. */
  readonly format?: WidgetAudioFormat;
  /** Worklet buffer window in milliseconds, `50`–`2000`; `500` when omitted. */
  readonly bufferMs?: number;
  /** Frames that must be buffered before (re)starting playback, **not** more than `bufferMs`. */
  readonly startMs?: number;
  /** `0`–`1`; `1` when omitted. */
  readonly volume?: number;
}

/** Read-only snapshot of one stream. */
export interface WidgetAudioStreamStatus {
  readonly state: WidgetAudioStreamState;
  readonly underruns: number;
  readonly dropped: number;
  readonly bufferedFrames: number;
  readonly capacityFrames: number;
}

/** Handle for one PCM stream. Every method is safe to call after the stream closed. */
export interface WidgetAudioStream {
  readonly id: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly format: WidgetAudioFormat;
  readonly capacityFrames: number;
  readonly startFrames: number;
  readonly volume: number;
  /** Accepted frames the worklet has not reported as consumed yet. */
  readonly bufferedFrames: number;
  readonly underruns: number;
  readonly dropped: number;
  readonly state: WidgetAudioStreamState;
  /** Settles when the stream finished, was closed or its instance went away. */
  readonly ended: Promise<WidgetAudioEnded>;
  /**
   * Appends one block of interleaved samples.
   *
   * The promise resolves with the worklet's answer: `true` when the whole block entered the ring
   * buffer, `false` when it lacked room and the block was discarded whole. It never means "played".
   * Shape errors are thrown synchronously, before anything is sent.
   */
  write(samples: Int16Array | Float32Array): Promise<boolean>;
  /** Drops everything that has not played yet and keeps the stream open. */
  clear(): void;
  /** Plays the remaining data and then ends with `finished`. Idempotent. */
  end(): void;
  /** Stops immediately and discards the remaining data. Idempotent. */
  close(): void;
  /** Fires once each time the buffer drains to half its capacity. */
  onDrain(listener: () => void): () => void;
  /** Fires when `state` or `underruns` changed. */
  onStatus(listener: (status: WidgetAudioStreamStatus) => void): () => void;
}

/** Instance-level audio API behind `api.audio`. */
export interface WidgetAudioApi {
  readonly state: WidgetAudioState;
  /** Subscribes to availability changes; the returned function unsubscribes. */
  onStateChange(listener: (state: WidgetAudioState) => void): () => void;
  /** Starts a continuous oscillator. */
  tone(options: WidgetAudioToneOptions): WidgetAudioTone;
  /** Opens a PCM stream. */
  createStream(options: WidgetAudioStreamOptions): WidgetAudioStream;
}
