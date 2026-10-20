/**
 * Bootstrap that runs inside the sandbox frame: it creates the classic worker from the inlined
 * runtime and hands the worker the messaging port. The frame itself never talks to the guest.
 */
const FRAME_BOOTSTRAP = `(function () {
  'use strict';
  var worker = null;
  var workerUrl = null;
  var workerReady = false;

  function post(message) {
    try {
      parent.postMessage(message, '*');
    } catch (error) {
      /* the host page is gone */
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'mica:boot') {
      try {
        workerUrl = URL.createObjectURL(new Blob([data.runtime], { type: 'text/javascript' }));
        worker = new Worker(workerUrl);
        worker.onmessage = function (event) {
          if (event.data && event.data.type === 'mica:worker-ready') workerReady = true;
        };
        // Only startup failures are interesting here; guest errors travel over the port.
        worker.onerror = function (error) {
          if (workerReady) return;
          post({ type: 'mica:frame-error', message: String((error && error.message) || 'worker failed to start') });
        };
        worker.onmessageerror = function () {
          if (workerReady) return;
          post({ type: 'mica:frame-error', message: 'worker message could not be deserialized' });
        };
        worker.postMessage(
          {
            type: 'mica:init',
            id: data.id,
            name: data.name,
            port: data.port,
            source: data.source,
            surface: data.surface,
            captureConsole: data.captureConsole
          },
          [data.port]
        );
      } catch (error) {
        post({ type: 'mica:frame-error', message: String((error && error.message) || error) });
      }
      return;
    }

    if (data.type === 'mica:terminate') {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      if (workerUrl) {
        URL.revokeObjectURL(workerUrl);
        workerUrl = null;
      }
    }
  });

  post({ type: 'mica:frame-ready' });
})();`;

export interface FrameDocumentOptions {
  csp: string;
  nonce?: string;
}

/** Builds the full frame document, either for `srcdoc` (nonce) or for a hosted static file. */
export function buildFrameDocument(options: FrameDocumentOptions): string {
  const nonceAttribute =
    options.nonce === undefined ? '' : ` nonce="${escapeAttribute(options.nonce)}"`;
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(options.csp)}">`,
    '<title>Mica sandbox</title>',
    '</head>',
    '<body>',
    `<script${nonceAttribute}>${FRAME_BOOTSTRAP}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export { FRAME_BOOTSTRAP };
