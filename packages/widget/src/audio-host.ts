// Keep workspace source consumers aware of the virtual AudioWorklet module.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./virtual-runtime.d.ts" />
export { WidgetAudioEngine } from './host/audio/engine';
export type { WidgetAudioEngineOptions } from './host/audio/engine';
export type { WidgetAudioControls, WidgetAudioOptions } from './host/audio/types';
export type { WidgetAudioMountInfo, WidgetAudioState } from './guest/audio/protocol';
