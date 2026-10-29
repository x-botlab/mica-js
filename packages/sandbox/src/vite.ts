// The ambient module is declared in `sandbox-worker.d.ts`; referencing it keeps consumer
// typechecks aware of the generated sandbox class.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./sandbox-worker.d.ts" />

export { micaSandboxPlugins } from './vite-plugin';
export type { SandboxAlias, SandboxPluginOptions } from './vite-plugin';
