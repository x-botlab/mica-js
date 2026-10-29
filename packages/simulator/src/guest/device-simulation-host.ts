/**
 * Default device simulation guest script.
 *
 * The package build bundles this module into one self-contained script (`?sandbox-worker-code`)
 * and inlines it into `sandbox.js`, so `createDeviceSimulationHostGuestSandbox()` can start it from
 * a `SandboxWorker` without the package publishing a separate file. The file is the worker body
 * itself: it handles the first ordinary message and hands `event.ports[0]` to the typed RPC
 * registration. `event.ports[1..]` stay the extra ports the caller transferred.
 *
 * The simulator ships no device models, so no resolver is passed and a schematic containing
 * component symbols resolves nothing. Packages that own devices bundle their own worker script that
 * calls `startDeviceSimulationHostGuest` with their library.
 */
import { startDeviceSimulationHostGuest } from '../host/guest';

let started = false;

self.addEventListener('message', (event: MessageEvent) => {
  if (started) return;
  const port = event.ports[0];
  if (port === undefined) return;
  started = true;
  startDeviceSimulationHostGuest(port, { ports: event.ports.slice(1) });
});
