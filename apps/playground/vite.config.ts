import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { micaSandboxPlugins } from '../../packages/sandbox/vite.plugins';

/** Every page consumes the workspace packages from source, so edits show up without a rebuild. */
export default defineConfig({
  plugins: [react(), tailwindcss(), ...micaSandboxPlugins()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@mica/core/schematic': fileURLToPath(
        new URL('../../packages/core/src/schematic/index.ts', import.meta.url),
      ),
      '@mica/schematic-editor': fileURLToPath(
        new URL('../../packages/schematic-editor/src/index.ts', import.meta.url),
      ),
      '@mica/sandbox': fileURLToPath(
        new URL('../../packages/sandbox/src/index.ts', import.meta.url),
      ),
    },
  },
});
