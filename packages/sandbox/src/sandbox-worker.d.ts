declare module '*?sandbox-worker' {
  import type { SandboxWorker, SandboxWorkerOptions } from '@mica-js/sandbox';

  /**
   * Ordinary module imported with the `?sandbox-worker` query, transformed by the
   * `@mica-js/sandbox/vite` plugin. The wildcard matches `.ts`, `.js` and extensionless
   * specifiers alike; the module itself becomes the self-contained worker script, and the default
   * export is a `SandboxWorker` subclass whose constructor already supplies that bundle, so
   * callers pass worker options only.
   */
  const GeneratedSandbox: new (options?: SandboxWorkerOptions) => SandboxWorker;
  export default GeneratedSandbox;
}

declare module '*?sandbox-worker-code' {
  /**
   * Ordinary module imported with the `?sandbox-worker-code` query, transformed by the
   * `@mica-js/sandbox/vite` plugin. The default export is the self-contained, minified worker
   * script itself, so a package can inline its guest into an ordinary module and start it from a
   * `new SandboxWorker(code)` at runtime instead of publishing a separate script file.
   */
  const code: string;
  export default code;
}
