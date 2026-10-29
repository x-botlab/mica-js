import type { WidgetAudioFormat } from '../../guest/audio/protocol';

/** Phases the coefficient table is sampled at; between two phases the taps blend linearly. */
export const PHASE_COUNT = 256;
/** Zero crossings on each side of the kernel. */
export const HALF_TAPS = 16;
export const TAPS = HALF_TAPS * 2;
/** Kaiser shape: about 80 dB of stop-band attenuation at the cutoff below. */
const KAISER_BETA = 8;
/** Cutoff as a fraction of the lower Nyquist frequency, leaving room for the transition band. */
const CUTOFF_FRACTION = 0.45;

/** Modified Bessel function of the first kind, order 0 (series form, plenty for a window). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) / 4;
  for (let k = 1; k < 64; k += 1) {
    term *= quarter / (k * k);
    sum += term;
    if (term <= sum * 1e-15) break;
  }
  return sum;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const angle = Math.PI * x;
  return Math.sin(angle) / angle;
}

function kaiser(x: number): number {
  if (x <= -1 || x >= 1) return 0;
  return besselI0(KAISER_BETA * Math.sqrt(1 - x * x)) / besselI0(KAISER_BETA);
}

/**
 * Band-limited interpolation coefficients.
 *
 * One window per phase, DC-normalized so a constant signal keeps its amplitude; the cutoff follows
 * the lower of the two rates, which also does the anti-aliasing when downsampling.
 */
export function buildCoefficients(ratio: number): Float32Array {
  const coefficients = new Float32Array(PHASE_COUNT * TAPS);
  const cutoff = CUTOFF_FRACTION * Math.min(1, 1 / ratio);
  for (let phase = 0; phase < PHASE_COUNT; phase += 1) {
    const fraction = phase / PHASE_COUNT;
    let sum = 0;
    for (let tap = 0; tap < TAPS; tap += 1) {
      // Distance between this tap and the interpolation point, in source samples.
      const offset = tap - (HALF_TAPS - 1) - fraction;
      const value = 2 * cutoff * sinc(2 * cutoff * offset) * kaiser(offset / HALF_TAPS);
      coefficients[phase * TAPS + tap] = value;
      sum += value;
    }
    if (sum !== 0) {
      for (let tap = 0; tap < TAPS; tap += 1) {
        coefficients[phase * TAPS + tap] = (coefficients[phase * TAPS + tap] ?? 0) / sum;
      }
    }
  }
  return coefficients;
}

/**
 * Windowed-sinc resampler for one PCM stream.
 *
 * The kernel is causal: `sample(read, position)` needs source frames up to `floor(position)`, and
 * the audible signal lags by {@link delayFrames} source frames. Callers position the read head
 * accordingly, which is why the delay is part of the public surface.
 */
export class SincResampler {
  readonly sourceRate: number;
  readonly targetRate: number;
  /** Source frames per output frame. */
  readonly ratio: number;
  readonly passthrough: boolean;
  /** Group delay in source frames; zero when the rates match. */
  readonly delayFrames: number;
  readonly #coefficients: Float32Array | undefined;

  constructor(sourceRate: number, targetRate: number) {
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
    this.ratio = sourceRate / targetRate;
    this.passthrough = sourceRate === targetRate;
    this.delayFrames = this.passthrough ? 0 : HALF_TAPS * Math.max(1, this.ratio);
    this.#coefficients = this.passthrough ? undefined : buildCoefficients(this.ratio);
  }

  /** Source frames the kernel reads below and above its center. */
  get span(): { readonly behind: number; readonly ahead: number } {
    if (this.passthrough) return { behind: 0, ahead: 0 };
    return { behind: HALF_TAPS - 1, ahead: HALF_TAPS };
  }

  /**
   * Interpolates one channel at fractional source frame `position`.
   *
   * @param read source accessor; out-of-range indexes must return `0`.
   */
  sample(read: (frame: number) => number, position: number): number {
    if (this.passthrough) return read(Math.round(position));

    const base = Math.floor(position);
    const scaled = (position - base) * PHASE_COUNT;
    const phase = Math.min(PHASE_COUNT - 1, Math.floor(scaled));
    const blend = Math.min(1, scaled - phase);
    const coefficients = this.#coefficients;
    if (coefficients === undefined) return read(base);

    const current = phase * TAPS;
    const last = phase + 1 >= PHASE_COUNT;
    const next = last ? 0 : (phase + 1) * TAPS;
    // Phase `PHASE_COUNT` is phase 0 of the next source frame, so its taps start one frame later.
    const shift = last && blend > 0 ? 1 : 0;
    const first = base - (HALF_TAPS - 1);
    let sum = 0;
    for (let tap = 0; tap < TAPS; tap += 1) {
      const index = first + tap;
      const weight = coefficients[current + tap] ?? 0;
      const nextWeight = coefficients[next + tap] ?? 0;
      sum += read(index) * weight * (1 - blend) + read(index + shift) * nextWeight * blend;
    }
    return sum;
  }
}

/** Converts one stored sample of `format` to `[-1, 1]`, clamping and sanitizing as RFC 0016 says. */
export function toFloat(value: number, format: WidgetAudioFormat): number {
  const scaled = format === 's16' ? value / 32768 : value;
  if (!Number.isFinite(scaled)) return 0;
  if (scaled > 1) return 1;
  if (scaled < -1) return -1;
  return scaled;
}
