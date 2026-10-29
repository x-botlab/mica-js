import workletScript from '../../guest/audio/entry.ts?audio-worklet-code';
import { widgetAudioWorkletProcessor } from '../../guest/audio/protocol';

let objectUrl: string | undefined;

/**
 * Blob URL of the packaged `AudioWorkletProcessor` script.
 *
 * The script is bundled and minified into this module while the package is built, so an
 * `AudioContext` can load it through `addModule()` without the package publishing a separate
 * `*.worklet.js` asset. The URL is created once per page and reused by every host.
 */
export function widgetAudioWorkletUrl(): string {
  objectUrl ??= URL.createObjectURL(new Blob([workletScript], { type: 'text/javascript' }));
  return objectUrl;
}

/**
 * Loads the packaged processor into `context` and creates its node.
 *
 * Pass it as `getAudioWorklet` wherever a `WidgetHost` or `CanvasEditor` asks for one; hosts that
 * provide no loader of their own use the same processor internally.
 */
export async function createWidgetAudioWorklet(context: AudioContext): Promise<AudioWorkletNode> {
  if (typeof context.audioWorklet?.addModule !== 'function') {
    throw new Error('The AudioContext does not support AudioWorklet.addModule().');
  }
  await context.audioWorklet.addModule(widgetAudioWorkletUrl());
  return new AudioWorkletNode(context, widgetAudioWorkletProcessor);
}
