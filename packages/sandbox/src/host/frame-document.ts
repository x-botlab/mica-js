/**
 * Bootstrap that runs inside the sandbox frame. It owns nothing but the worker lifecycle: the
 * caller's bundler output *is* the worker script, and ordinary host messages are forwarded to the
 * native Worker without a guest-side startup envelope.
 */
const FRAME_BOOTSTRAP = `(function () {
  'use strict';
  var worker = null;
  var workerUrl = null;

  function post(message, transfer) {
    try {
      parent.postMessage(message, '*', transfer || []);
    } catch (error) {
      /* the host page is gone */
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;

    if (!worker && data && typeof data === 'object' && data.type === 'mica:boot') {
      try {
        workerUrl = URL.createObjectURL(new Blob([data.code], { type: 'text/javascript' }));
        worker = new Worker(workerUrl);
        worker.onmessage = function (message) {
          post({ type: 'mica:worker-message', data: message.data }, message.ports);
        };
        worker.onmessageerror = function (message) {
          post({ type: 'mica:worker-messageerror', data: message && message.data }, message && message.ports);
        };
        worker.onerror = function (error) {
          post({
            type: 'mica:worker-error',
            message: String((error && error.message) || 'worker failed'),
            filename: (error && error.filename) || '',
            lineno: (error && error.lineno) || 0,
            colno: (error && error.colno) || 0
          });
        };
        post({ type: 'mica:worker-started' });
      } catch (error) {
        post({ type: 'mica:frame-error', message: String((error && error.message) || error) });
      }
      return;
    }

    if (
      data &&
      typeof data === 'object' &&
      data.type === 'mica:terminate' &&
      data.control === true
    ) {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      if (workerUrl) {
        URL.revokeObjectURL(workerUrl);
        workerUrl = null;
      }
      return;
    }

    if (worker) {
      try {
        worker.postMessage(data, event.ports);
      } catch (error) {
        post({ type: 'mica:frame-error', message: String((error && error.message) || error) });
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
