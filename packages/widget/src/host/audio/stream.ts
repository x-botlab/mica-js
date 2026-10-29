import { SincResampler, toFloat } from './resample';
import type { WidgetAudioFormat, WidgetAudioStreamState } from '../../guest/audio/protocol';

/** Declick window applied when a stream (re)starts or ends. */
export const FADE_SECONDS = 0.002;

export interface StreamInit {
  readonly streamId: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly format: WidgetAudioFormat;
  readonly capacityFrames: number;
  readonly startFrames: number;
  readonly volume: number;
}

/** Ring buffer of interleaved frames addressed by absolute frame index. */
export class StreamBuffer {
  readonly capacity: number;
  readonly channels: number;
  readonly data: Float32Array;
  written = 0;
  /** Frames below this index are stale history: the filter must not read them back. */
  readFloor = 0;

  constructor(capacity: number, channels: number) {
    this.capacity = capacity;
    this.channels = channels;
    this.data = new Float32Array(capacity * channels);
  }

  /** Appends `frames` frames; the caller already checked the capacity. */
  write(samples: Int16Array | Float32Array, frames: number, format: WidgetAudioFormat): void {
    for (let frame = 0; frame < frames; frame += 1) {
      const target = ((this.written + frame) % this.capacity) * this.channels;
      for (let channel = 0; channel < this.channels; channel += 1) {
        this.data[target + channel] = toFloat(
          samples[frame * this.channels + channel] ?? 0,
          format,
        );
      }
    }
    this.written += frames;
  }

  at(frame: number, channel: number): number {
    if (frame < this.readFloor || frame >= this.written) return 0;
    return this.data[(frame % this.capacity) * this.channels + channel] ?? 0;
  }
}

/** One PCM stream: buffering, credit accounting and the resampling read head. */
export class PcmStream {
  readonly streamId: string;
  readonly channels: number;
  readonly format: WidgetAudioFormat;
  readonly capacityFrames: number;
  readonly startFrames: number;
  readonly buffer: StreamBuffer;
  readonly resampler: SincResampler;
  volume: number;
  state: WidgetAudioStreamState = 'buffering';
  underruns = 0;
  endRequested = false;
  finished = false;
  closed = false;
  /** Last state the worklet reported, so it only posts progress on real changes. */
  reportedState: WidgetAudioStreamState = 'buffering';
  /** Fractional source position the next output sample reads, including the kernel delay. */
  position: number;
  consumed = 0;
  #fadeRemaining = 0;

  constructor(init: StreamInit, deviceRate: number) {
    this.streamId = init.streamId;
    this.channels = init.channels;
    this.format = init.format;
    this.capacityFrames = init.capacityFrames;
    this.startFrames = init.startFrames;
    this.volume = init.volume;
    this.buffer = new StreamBuffer(init.capacityFrames, init.channels);
    this.resampler = new SincResampler(init.sampleRate, deviceRate);
    this.position = this.resampler.delayFrames;
  }

  get bufferedFrames(): number {
    return Math.max(0, this.buffer.written - this.consumed);
  }

  /** Appends one block, or rejects it whole when it would overflow the buffer. */
  write(samples: Int16Array | Float32Array, frames: number): boolean {
    if (this.closed) return false;
    if (frames <= 0) return false;
    if (this.bufferedFrames + frames > this.capacityFrames) return false;
    this.buffer.write(samples, frames, this.format);
    return true;
  }

  clear(): void {
    this.consumed = this.buffer.written;
    // RFC 0016: `clear()` resets the filter history, so discarded frames never leak back in.
    this.buffer.readFloor = this.buffer.written;
    this.position = this.buffer.written + this.resampler.delayFrames;
    this.state = 'buffering';
    this.#fadeRemaining = 0;
  }

  render(output: Float32Array[], frames: number, gain: number, fadeFrames: number): void {
    if (this.closed || output.length === 0) return;

    const { resampler, buffer } = this;
    const span = resampler.span;
    const delay = resampler.delayFrames;
    // `end()` pads past the last frame with zeros, so a tail shorter than the kernel still plays.
    const lastCenter = this.endRequested ? buffer.written - 1 : buffer.written - 1 - span.ahead;
    const firstCenter = this.position - delay;
    const renderable = Math.ceil((lastCenter + 1 - firstCenter) / resampler.ratio);
    // Declick only when the data really ends within this quantum; a producer that refills in time
    // must not hear a dip every quantum.
    const fadeOut = this.endRequested || renderable < frames;
    const fadeSpan = Math.max(1, fadeFrames - 1);

    for (let index = 0; index < frames; index += 1) {
      const center = this.position - delay;
      if (this.state !== 'playing') {
        const available = buffer.written - Math.floor(center);
        // `end()` plays whatever is left even when it is below `startFrames`.
        if (available < (this.endRequested ? 1 : Math.max(this.startFrames, 1))) break;
        // A (re)start resets the filter history; only the frames from here on are audible.
        buffer.readFloor = Math.max(buffer.readFloor, Math.floor(center));
        this.state = 'playing';
        this.#fadeRemaining = fadeFrames;
      }

      if (Math.floor(center) > lastCenter) {
        if (this.endRequested) {
          this.finished = true;
          this.state = 'ended';
        } else {
          // Underrun: pad with silence, count it and require `startFrames` again before resuming.
          this.state = 'buffering';
          this.underruns += 1;
          this.#fadeRemaining = 0;
        }
        break;
      }

      let local = gain * this.volume;
      if (fadeOut) {
        const remainingOutput = Math.ceil((lastCenter + 1 - center) / resampler.ratio);
        // ~2 ms ramp down to silence at the underrun or end boundary.
        if (remainingOutput <= fadeFrames) {
          local *= Math.max(0, remainingOutput - 1) / fadeSpan;
        }
      }
      if (this.#fadeRemaining > 0) {
        local *= 1 - this.#fadeRemaining / fadeFrames;
        this.#fadeRemaining -= 1;
      }

      if (this.channels === 1) {
        const value = resampler.sample((frame) => buffer.at(frame, 0), center) * local;
        for (const channel of output) {
          channel[index] = (channel[index] ?? 0) + value;
        }
      } else {
        for (let channel = 0; channel < this.channels; channel += 1) {
          const target = output[Math.min(channel, output.length - 1)];
          if (!target) continue;
          target[index] =
            (target[index] ?? 0) +
            resampler.sample((frame) => buffer.at(frame, channel), center) * local;
        }
      }

      this.position += resampler.ratio;
      const played = Math.min(buffer.written, Math.floor(this.position - delay));
      if (played > this.consumed) this.consumed = played;
    }
  }
}
