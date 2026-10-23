import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { micaSandboxPlugins } from '../../packages/sandbox/vite.plugins';
import { micaWidgetPlugins } from '../../packages/widget/vite.plugins';

/** Every page consumes the workspace packages from source, so edits show up without a rebuild. */
export default defineConfig({
  // The widget guest runtime is a build-time bundle: its virtual module has to be provided here.
  plugins: [react(), tailwindcss(), ...micaSandboxPlugins(), ...micaWidgetPlugins()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@mica-js/canvas-editor': fileURLToPath(
        new URL('../../packages/canvas-editor/src/index.ts', import.meta.url),
      ),
      '@mica-js/widget': fileURLToPath(
        new URL('../../packages/widget/src/index.ts', import.meta.url),
      ),
      '@mica-js/core/canvas': fileURLToPath(
        new URL('../../packages/core/src/canvas/index.ts', import.meta.url),
      ),
      '@mica-js/core/schematic': fileURLToPath(
        new URL('../../packages/core/src/schematic/index.ts', import.meta.url),
      ),
      '@mica-js/schematic-editor': fileURLToPath(
        new URL('../../packages/schematic-editor/src/index.ts', import.meta.url),
      ),
      '@mica-js/sandbox': fileURLToPath(
        new URL('../../packages/sandbox/src/index.ts', import.meta.url),
      ),
    },
  },
});
