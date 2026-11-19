/**
 * 2D presentation guest worker entry.
 *
 * `?sandbox-worker` bundles this module into one self-contained classic script and inlines it into
 * the editor, so the runtime starts it from a `SandboxWorker` without publishing a separate file.
 * The first ordinary message carries the RPC port in `event.ports[0]` and the model lane in
 * `event.ports[1]`.
 */
import { startFusedDisplayGuest } from './guest';

let started = false;

self.addEventListener('message', (event: MessageEvent) => {
  if (started) return;
  const port = event.ports[0];
  if (port === undefined) return;
  started = true;
  startFusedDisplayGuest(port, { ports: event.ports.slice(1) });
});
