/**
 * Widget guest worker script.
 *
 * The package build bundles this module into one self-contained script (`?sandbox-worker-code`)
 * and inlines it into `index.js`, so `createWidgetHostGuestSandbox()` can start it from a
 * `SandboxWorker` without the package publishing a separate file. It speaks the native worker
 * protocol: the first ordinary message carries the RPC port in `event.ports[0]` and the direct
 * device channel, when the assembly layer wired one, in `event.ports[1]`. Everything else is
 * ordinary RPC over those ports.
 */
import { startWidgetRuntime } from './runtime';

let started = false;

self.addEventListener('message', (event: MessageEvent) => {
  if (started) return;
  const port = event.ports[0];
  if (port === undefined) return;
  started = true;
  startWidgetRuntime(port, { ports: event.ports.slice(1) });
});
