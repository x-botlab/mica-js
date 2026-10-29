declare module '*?sandbox-worker' {
  import type { SandboxWorker, SandboxWorkerOptions } from '@mica-js/sandbox';

  /**
   * Ordinary module imported with the `?sandbox-worker` query, transformed by the
   * `@mica-js/sandbox/vite` plugin. The wildcard matches `.ts`, `.js` and extensionless specifiers
   * alike; the default export is a `SandboxWorker` subclass whose constructor already supplies the
   * bundled guest source, so callers pass worker options only.
   */
  const GeneratedSandbox: new (options?: SandboxWorkerOptions) => SandboxWorker;
  export default GeneratedSandbox;
}
