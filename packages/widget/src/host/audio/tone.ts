import type { WidgetOscillatorType } from '../../guest/audio/protocol';

/** Smallest smoothing window; `rampMs: 0` still avoids a click. */
export const MIN_RAMP_SECONDS = 0.005;

const TAU = Math.PI * 2;

export interface ToneInit {
  readonly type: WidgetOscillatorType;
  /** Hz, `(0, 24000]`. */
  readonly frequency: number;
  /** `0`–`1`. */
  readonly volume: number;
}

export interface ToneSettings {
  readonly volume?: number;
  readonly frequency?: number;
  /** Smoothing window in milliseconds. */
  readonly rampMs: number;
}

/**
 * Band-limited oscillator voice.
 *
 * The worklet synthesizes every waveform itself: `sine` is exact, `sawtooth` and `square` use
 * PolyBLEP correction at their discontinuities, `triangle` is the naive shape whose 1/n² spectrum
 * needs no correction at these rates. Parameters glide linearly, so `set()` never clicks.
 */
export class ToneVoice {
  readonly id: string;
  readonly type: WidgetOscillatorType;
  readonly #sampleRate: number;
  #phase = 0;
  #frequency: number;
  #frequencyStep = 0;
  #frequencyRemaining = 0;
  #volume: number;
  #volumeStep = 0;
  #volumeRemaining = 0;
  #fadeRemaining = 0;
  #fadeTotal = 0;
  #finished = false;

  constructor(id: string, init: ToneInit, sampleRate: number) {
    this.id = id;
    this.type = init.type;
    this.#sampleRate = sampleRate;
    this.#frequency = init.frequency;
    this.#volume = init.volume;
  }

  get frequency(): number {
    return this.#frequency;
  }

  get volume(): number {
    return this.#volume;
  }

  get finished(): boolean {
    return this.#finished;
  }

  set(settings: ToneSettings): void {
    if (this.#finished) return;
    const seconds = Math.max(MIN_RAMP_SECONDS, settings.rampMs / 1000);
    if (settings.frequency !== undefined) {
      this.#rampFrequency(settings.frequency, seconds);
    }
    if (settings.volume !== undefined) {
      this.#rampVolume(settings.volume, seconds);
    }
  }

  /** Fades out over `fadeMs`; `0` finishes on the spot. */
  stop(fadeMs: number): void {
    if (this.#finished) return;
    const total = Math.round((fadeMs / 1000) * this.#sampleRate);
    if (total <= 0) {
      this.#finished = true;
      return;
    }
    this.#fadeTotal = total;
    this.#fadeRemaining = total;
  }

  render(output: Float32Array[], frames: number, gain: number): void {
    if (this.#finished || output.length === 0) return;

    for (let index = 0; index < frames; index += 1) {
      this.#advance();
      const step = this.#frequency / this.#sampleRate;
      let value = this.#wave(step) * this.#volume * gain;
      if (this.#fadeRemaining > 0) {
        value *= this.#fadeRemaining / this.#fadeTotal;
        this.#fadeRemaining -= 1;
      }
      for (const channel of output) {
        channel[index] = (channel[index] ?? 0) + value;
      }
      this.#phase += step;
      if (this.#phase >= 1) this.#phase -= Math.floor(this.#phase);
      if (this.#fadeRemaining === 0 && this.#fadeTotal > 0) {
        this.#finished = true;
        return;
      }
    }
  }

  #rampFrequency(target: number, seconds: number): void {
    const samples = Math.max(1, Math.round(seconds * this.#sampleRate));
    this.#frequencyStep = (target - this.#frequency) / samples;
    this.#frequencyRemaining = samples;
    if (this.#frequencyStep === 0) this.#frequency = target;
  }

  #rampVolume(target: number, seconds: number): void {
    const samples = Math.max(1, Math.round(seconds * this.#sampleRate));
    this.#volumeStep = (target - this.#volume) / samples;
    this.#volumeRemaining = samples;
    if (this.#volumeStep === 0) this.#volume = target;
  }

  #advance(): void {
    if (this.#frequencyRemaining > 0) {
      this.#frequency += this.#frequencyStep;
      this.#frequencyRemaining -= 1;
    }
    if (this.#volumeRemaining > 0) {
      this.#volume += this.#volumeStep;
      this.#volumeRemaining -= 1;
    }
  }

  #wave(step: number): number {
    const phase = this.#phase;
    switch (this.type) {
      case 'sine':
        return Math.sin(TAU * phase);
      case 'square':
        return (phase < 0.5 ? 1 : -1) + polyBlep(phase, step) - polyBlep(wrap(phase + 0.5), step);
      case 'sawtooth':
        return 2 * phase - 1 - polyBlep(phase, step);
      case 'triangle':
        return 1 - 4 * Math.abs(phase - 0.5);
    }
  }
}

function wrap(phase: number): number {
  return phase >= 1 ? phase - 1 : phase;
}

/** PolyBLEP residual that rounds a step discontinuity over one sample. */
function polyBlep(phase: number, step: number): number {
  if (step <= 0 || step >= 1) return 0;
  if (phase < step) {
    const t = phase / step;
    return t + t - t * t - 1;
  }
  if (phase > 1 - step) {
    const t = (phase - 1) / step;
    return t * t + t + t + 1;
  }
  return 0;
}
