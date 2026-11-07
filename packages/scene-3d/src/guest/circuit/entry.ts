/** Classic worker entry for a direct circuit guest. */
import { startCircuitRuntime } from './runtime';

let started = false;
self.addEventListener('message', (event: MessageEvent) => {
  if (started) return;
  const port = event.ports[0];
  if (port === undefined) return;
  started = true;
  startCircuitRuntime(port);
});
