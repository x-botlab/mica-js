/* global self */
/**
 * Ordinary worker entry used to prove `?sandbox-worker` is independent of the source extension.
 * A sandbox guest is a plain worker script: it owns its message handler and replies natively.
 */
self.addEventListener('message', (event) => {
  self.postMessage({ answer: 42, echo: event.data });
});
