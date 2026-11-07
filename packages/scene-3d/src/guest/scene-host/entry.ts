/** Classic worker entry for the scene-host guest. */
import { startSceneHostRuntime } from './runtime';

let started = false;
self.addEventListener('message', (event: MessageEvent) => {
  if (started) return;
  const port = event.ports[0];
  if (port === undefined) return;
  started = true;
  startSceneHostRuntime(port).catch((error: unknown) => {
    // `postMessage` has no error channel, so report through the worker error surface the sandbox
    // forwards to `onError` instead of leaving an unhandled rejection behind.
    self.reportError?.(error);
  });
});
