import { describe, expect, it } from 'vitest';
import { PHASE_COUNT, SincResampler, TAPS, buildCoefficients, toFloat } from './resample';

/**
 * Renders `count` output samples of an analytic source.
 *
 * `sample()` takes the kernel center, which already includes the delay the read head applies; the
 * first output sample therefore looks at source frame 0.
 */
function render(
  resampler: SincResampler,
  source: (frame: number) => number,
  count: number,
): number[] {
  const output: number[] = [];
  let position = 0;
  for (let n = 0; n < count; n += 1) {
    output.push(resampler.sample(source, position));
    position += resampler.ratio;
  }
  return output;
}

function sine(frequency: number, sampleRate: number): (frame: number) => number {
  return (frame) => Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
}

describe('buildCoefficients', () => {
  it('normalizes every phase to unity DC gain', () => {
    const coefficients = buildCoefficients(22050 / 48000);
    expect(coefficients).toHaveLength(PHASE_COUNT * TAPS);
    for (let phase = 0; phase < PHASE_COUNT; phase += 1) {
      let sum = 0;
      for (let tap = 0; tap < TAPS; tap += 1) sum += coefficients[phase * TAPS + tap] ?? 0;
      expect(sum).toBeCloseTo(1, 5);
    }
  });
});

describe('SincResampler', () => {
  it('passes matching rates straight through', () => {
    const resampler = new SincResampler(48000, 48000);
    expect(resampler.passthrough).toBe(true);
    expect(resampler.ratio).toBe(1);
    expect(resampler.delayFrames).toBe(0);
    expect(resampler.sample((frame) => frame, 3.2)).toBe(3);
  });

  it('keeps a constant signal constant', () => {
    const resampler = new SincResampler(22050, 48000);
    const output = render(resampler, () => 0.25, 512);
    for (const value of output.slice(64)) {
      expect(value).toBeCloseTo(0.25, 6);
    }
  });

  it('upsamples without changing the frequency', () => {
    const sourceRate = 22050;
    const targetRate = 48000;
    const frequency = 1000;
    const resampler = new SincResampler(sourceRate, targetRate);
    const output = render(resampler, sine(frequency, sourceRate), 2048);

    let worst = 0;
    for (let n = 256; n < output.length; n += 1) {
      const expected = Math.sin((2 * Math.PI * frequency * n) / targetRate);
      worst = Math.max(worst, Math.abs((output[n] ?? 0) - expected));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('downsamples without changing the frequency', () => {
    const sourceRate = 48000;
    const targetRate = 22050;
    const frequency = 800;
    const resampler = new SincResampler(sourceRate, targetRate);
    const output = render(resampler, sine(frequency, sourceRate), 2048);

    let worst = 0;
    for (let n = 256; n < output.length; n += 1) {
      const expected = Math.sin((2 * Math.PI * frequency * n) / targetRate);
      worst = Math.max(worst, Math.abs((output[n] ?? 0) - expected));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('rejects content above the lower Nyquist frequency when downsampling', () => {
    const sourceRate = 48000;
    const targetRate = 8000;
    const resampler = new SincResampler(sourceRate, targetRate);
    // 6 kHz is far above the 4 kHz Nyquist of the target rate; only aliasing could survive.
    const output = render(resampler, sine(6000, sourceRate), 2048);
    let peak = 0;
    for (const value of output.slice(512)) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeLessThan(0.05);
  });

  it('reports a delay of 16 frames at the lower rate', () => {
    expect(new SincResampler(22050, 48000).delayFrames).toBeCloseTo(16, 6);
    expect(new SincResampler(48000, 22050).delayFrames).toBeCloseTo(16 * (48000 / 22050), 6);
  });
});

describe('toFloat', () => {
  it('scales s16 and clamps f32', () => {
    expect(toFloat(32768, 's16')).toBe(1);
    expect(toFloat(-32768, 's16')).toBe(-1);
    expect(toFloat(16384, 's16')).toBe(0.5);
    expect(toFloat(4, 'f32')).toBe(1);
    expect(toFloat(-4, 'f32')).toBe(-1);
    expect(toFloat(Number.NaN, 'f32')).toBe(0);
    expect(toFloat(0.25, 'f32')).toBe(0.25);
  });
});
