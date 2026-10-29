import type { WidgetAudioLimits, WidgetAudioState } from '../../guest/audio/protocol';

/** Per-instance audio ceilings (`WidgetAudioLimits` lives with the protocol it bounds). */
export type { WidgetAudioLimits, WidgetAudioState } from '../../guest/audio/protocol';

/**
 * Host audio configuration for `createWidgetHost` (RFC 0016).
 *
 * Omit it and `api.audio.state` is `unavailable`: every method still returns a usable handle, but
 * nothing is ever played.
 */ export interface WidgetAudioOptions {
  /** Context all audio renders into. The caller owns it; the host never closes it. */
  readonly context: AudioContext;
  /** Where the host's master gain ends up; defaults to `context.destination`. */
  readonly destination?: AudioNode;
  /** Creates the worklet node after the host has created the context. */
  readonly getAudioWorklet?: (context: AudioContext) => Promise<AudioWorkletNode>;
  /** Tightens the defaults (8 voices, 4 PCM streams per instance). */
  readonly limits?: Partial<WidgetAudioLimits>;
}

/** `WidgetHost.audio` — controls every instance of one widget host. */
export interface WidgetAudioControls {
  /** Mirror of the state the guest reads from `api.audio.state`. */
  readonly state: WidgetAudioState;
  /** Mutes every instance without touching buffers; PCM keeps flowing into the worklet. */
  setMuted(muted: boolean): void;
  /**
   * Scales one instance inside the worklet.
   *
   * @throws {TypeError} when `volume` is not a number.
   * @throws {RangeError} when it is outside `[0, 1]`.
   */
  setInstanceVolume(instanceId: string, volume: number): void;
  /**
   * Freezes all widget audio, for example while a simulation is paused.
   *
   * Tones go silent and the worklet pauses consumption while keeping the PCM it already buffered.
   * The caller's `AudioContext` is left alone.
   */
  suspend(): void;
  resume(): void;
}
