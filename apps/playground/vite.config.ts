import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { micaSandboxPlugins } from '../../packages/sandbox/vite.plugins';
import { micaWidgetPlugins } from '../../packages/widget/src/build/vite';

/** Every page consumes the workspace packages from source, so edits show up without a rebuild. */
export default defineConfig({
  // Guest bundles are build-time transformations: the workspace packages inline their own guest
  // worker and worklet, and `?sandbox-worker` stays for the Playground's custom device guest.
  plugins: [react(), tailwindcss(), ...micaSandboxPlugins(), ...micaWidgetPlugins()],
  resolve: {
    // An array, because `?sandbox-worker` keeps its query when Vite applies aliases: a string alias
    // only matches whole segments, so the widget runtime subpath needs a prefix pattern.
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      {
        find: '@mica-js/canvas-editor/style.css',
        replacement: fileURLToPath(
          new URL('../../packages/canvas-editor/src/styles/editor.css', import.meta.url),
        ),
      },
      {
        find: '@mica-js/canvas-editor',
        replacement: fileURLToPath(
          new URL('../../packages/canvas-editor/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@mica-js/widget',
        replacement: fileURLToPath(new URL('../../packages/widget/src/index.ts', import.meta.url)),
      },
      {
        find: '@mica-js/core/rpc',
        replacement: fileURLToPath(
          new URL('../../packages/core/src/rpc/index.ts', import.meta.url),
        ),
      },
      {
        find: '@mica-js/core/logging',
        replacement: fileURLToPath(
          new URL('../../packages/core/src/logging/index.ts', import.meta.url),
        ),
      },
      {
        find: '@mica-js/core/lifecycle',
        replacement: fileURLToPath(
          new URL('../../packages/core/src/lifecycle/index.ts', import.meta.url),
        ),
      },
      {
        find: '@mica-js/core/canvas',
        replacement: fileURLToPath(
          new URL('../../packages/core/src/canvas/index.ts', import.meta.url),
        ),
      },
      {
        find: '@mica-js/core/schematic',
        replacement: fileURLToPath(
          new URL('../../packages/core/src/schematic/index.ts', import.meta.url),
        ),
      },
      // Keep the bare package last: Vite matches aliases by prefix, so `@mica-js/core` would
      // otherwise swallow `@mica-js/core/canvas` and `@mica-js/core/schematic`.
      {
        find: '@mica-js/core',
        replacement: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      },
      {
        find: '@mica-js/device',
        replacement: fileURLToPath(new URL('../../packages/device/src/index.ts', import.meta.url)),
      },
      {
        find: '@mica-js/ir',
        replacement: fileURLToPath(new URL('../../packages/ir/src/index.ts', import.meta.url)),
      },
      {
        find: '@mica-js/simulator/sandbox',
        replacement: fileURLToPath(
          new URL('../../packages/simulator/src/sandbox.ts', import.meta.url),
        ),
      },
      // Keep the bare package last: Vite matches aliases by prefix, so `@mica-js/simulator`
      // would otherwise swallow `@mica-js/simulator/sandbox`.
      {
        find: '@mica-js/simulator',
        replacement: fileURLToPath(
          new URL('../../packages/simulator/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@mica-js/schematic-editor/style.css',
        replacement: fileURLToPath(
          new URL('../../packages/schematic-editor/src/styles/editor.css', import.meta.url),
        ),
      },
      {
        find: '@mica-js/schematic-editor',
        replacement: fileURLToPath(
          new URL('../../packages/schematic-editor/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@mica-js/sandbox',
        replacement: fileURLToPath(new URL('../../packages/sandbox/src/index.ts', import.meta.url)),
      },
    ],
  },
});
