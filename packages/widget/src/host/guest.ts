import { SandboxWorker } from '@mica-js/sandbox';
import type { SandboxWorkerOptions } from '@mica-js/sandbox';
import guestScript from '../guest/widget/entry.ts?sandbox-worker-code';

/**
 * The widget guest worker script, bundled and minified into this module by
 * `@mica-js/sandbox/vite` while the package itself is built.
 *
 * It is a classic script: every dependency is inlined, so the sandbox can run it without a module
 * loader and the package publishes no separate `*.sandbox.js` file.
 */
export const widgetGuestScript: string = guestScript;

/**
 * Creates the widget host guest worker.
 *
 * Hosts start the guest, then wire its RPC surface with `createWidgetSandboxFromWorker`.
 */
export function createWidgetHostGuestSandbox(options: SandboxWorkerOptions = {}): SandboxWorker {
  return new SandboxWorker(widgetGuestScript, { name: 'widget', ...options });
}
