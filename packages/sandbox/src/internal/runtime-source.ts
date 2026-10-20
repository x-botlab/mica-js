// The ambient module is declared in `virtual-runtime.d.ts`; referencing it keeps consumer
// typechecks (e.g. the playground aliasing `src/index.ts`) aware of the virtual module.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../virtual-runtime.d.ts" />
import runtime from 'virtual:mica-sandbox-runtime';

/** Bundled at build time by `vite.plugins.ts`. */
export const GUEST_RUNTIME_SOURCE: string = runtime;
