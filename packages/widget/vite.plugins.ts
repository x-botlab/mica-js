import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import type { Plugin } from 'vite';

const RUNTIME_ID = 'virtual:mica-widget-runtime';
const RESOLVED_RUNTIME_ID = `\0${RUNTIME_ID}`;

/**
 * Bundles the guest runtime into a single ESM source string. The sandbox loads it as a module from
 * a blob URL inside its worker, so the bundle must stay self-contained: no bare imports survive.
 */
function widgetRuntimePlugin(): Plugin {
  let bundled: Promise<string> | undefined;

  return {
    name: 'mica-widget:runtime',
    resolveId(id) {
      return id === RUNTIME_ID ? RESOLVED_RUNTIME_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_RUNTIME_ID) return null;
      bundled ??= bundleRuntime();
      return `export default ${JSON.stringify(await bundled)};`;
    },
  };
}

async function bundleRuntime(): Promise<string> {
  const result = await build({
    input: fileURLToPath(new URL('./src/runtime/worker-entry.ts', import.meta.url)),
    output: { format: 'es', codeSplitting: false },
    write: false,
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap((output) => output.output).find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') {
    throw new Error('mica-widget: the guest runtime produced no bundle');
  }
  return chunk.code;
}

export function micaWidgetPlugins(): Plugin[] {
  return [widgetRuntimePlugin()];
}
