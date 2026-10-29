declare module '*?sandbox-worker-code' {
  /**
   * Ordinary module imported with the `?sandbox-worker-code` query, transformed by the
   * `@mica-js/sandbox/vite` plugin. The default export is the self-contained, minified worker
   * script, ready to inline into a module that starts a `SandboxWorker` from it.
   */
  const code: string;
  export default code;
}
