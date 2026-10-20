import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import type { Plugin } from 'vite';
import { SANDBOX_FRAME_HTML } from './src/host/frame-html';

const RUNTIME_ID = 'virtual:mica-sandbox-runtime';
const RESOLVED_RUNTIME_ID = `\0${RUNTIME_ID}`;

/**
 * Bundles the guest runtime into a self-contained classic worker script and exposes it as a
 * string module. The worker is created from a blob URL inside an opaque-origin iframe, so it
 * cannot be a module worker (chrome fails to create module workers there) and cannot be a
 * separate file (opaque origins cannot fetch same-origin assets).
 */
function guestRuntimePlugin(): Plugin {
  return {
    name: 'mica-sandbox:guest-runtime',
    resolveId(id) {
      return id === RUNTIME_ID ? RESOLVED_RUNTIME_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_RUNTIME_ID) return null;

      const result = await build({
        input: fileURLToPath(new URL('./src/guest/worker-entry.ts', import.meta.url)),
        output: { format: 'iife', codeSplitting: false },
        write: false,
      });
      const outputs = Array.isArray(result) ? result : [result];
      const chunk = outputs
        .flatMap((output) => output.output)
        .find((item) => item.type === 'chunk');
      if (!chunk) {
        throw new Error('mica-sandbox: the guest runtime produced no bundle');
      }
      return `export default ${JSON.stringify(chunk.code)};`;
    },
  };
}

/** Emits `sandbox-frame.html` next to the bundle so apps can host it for the `frameUrl` mode. */
function frameHtmlPlugin(): Plugin {
  return {
    name: 'mica-sandbox:frame-html',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'sandbox-frame.html',
        source: SANDBOX_FRAME_HTML,
      });
    },
  };
}

export function micaSandboxPlugins(): Plugin[] {
  return [guestRuntimePlugin(), frameHtmlPlugin()];
}
