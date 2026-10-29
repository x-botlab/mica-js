/**
 * `AudioWorkletProcessor` wrapper around {@link WidgetAudioProcessor}.
 *
 * The package build bundles this module into one self-contained script (`?audio-worklet-code`) and
 * inlines it into `index.js`, so `createWidgetAudioWorklet()` can load it from a Blob URL without
 * the package publishing a separate `*.worklet.js` asset. It never runs outside a worklet scope,
 * which is why the two globals below are declared here instead of pulled in from a DOM type.
 */
import { WidgetAudioProcessor } from '../../host/audio/processor';
import { widgetAudioWorkletProcessor } from './protocol';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class MicaAudioProcessor extends AudioWorkletProcessor {
  readonly #processor: WidgetAudioProcessor;

  constructor() {
    super();
    this.#processor = new WidgetAudioProcessor({ sampleRate });
    // Host controls and diagnostics use the node port; the guest gets a port of its own.
    this.#processor.attachHostPort(this.port);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.#processor.process(outputs);
  }
}

registerProcessor(widgetAudioWorkletProcessor, MicaAudioProcessor);
