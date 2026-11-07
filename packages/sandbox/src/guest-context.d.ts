/**
 * Ambient types for sandbox guests.
 *
 * The worker bootstrap installs `$sandbox` on the global scope before guest code runs, so guest
 * source uses it directly and never imports it. Register these types once per guest project:
 *
 * ```json
 * { "compilerOptions": { "types": ["@mica-js/sandbox/guest"] } }
 * ```
 *
 * @example
 * ```ts
 * const config = await $sandbox.invoke('getConfig');
 *
 * $sandbox.export({
 *   step: (deltaMs: number) => physics.step(deltaMs),
 *   reset: () => physics.reset(),
 * });
 *
 * $sandbox.signal.addEventListener('abort', () => physics.dispose(), { once: true });
 * ```
 */

import type { ParentSandbox, SandboxContext } from './index';

declare global {
  /**
   * Context injected into the guest Worker before its code is evaluated.
   *
   * Available at the top level, including across top-level `await`s.
   */
  const $sandbox: SandboxContext;

  /**
   * Returns the parent channel of a child sandbox.
   *
   * Available only in guests created with `$sandbox.createChildSandbox()`; throws at top level.
   * Equivalent to `$sandbox.parent`, but clearer when the guest code is written to run only as a
   * child. Installed by the guest runtime before the guest program is evaluated.
   */
  function connectToParent(): ParentSandbox;
}

export {};
