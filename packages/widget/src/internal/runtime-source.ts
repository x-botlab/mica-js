// The ambient module is declared in `virtual-runtime.d.ts`; referencing it keeps consumer
// typechecks (for example tests importing `src/index.ts`) aware of the virtual module.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../virtual-runtime.d.ts" />
import runtime from 'virtual:mica-widget-runtime';

/** ESM guest runtime for widget instances, bundled at build time by `vite.plugins.ts`. */
export const WIDGET_RUNTIME_SOURCE: string = runtime;
