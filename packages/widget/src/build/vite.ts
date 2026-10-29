// The ambient modules are declared in `virtual-runtime.d.ts`; referencing them keeps consumer
// typechecks aware of the `?sandbox-worker`, `?sandbox-worker-code` and `?audio-worklet` queries.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../virtual-runtime.d.ts" />

export { micaWidgetPlugins, WIDGET_AUDIO_WORKLET_FILE_NAME } from './vite-plugin';
export type { WidgetPluginOptions } from './vite-plugin';
