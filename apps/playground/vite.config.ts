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
    conditions: ['source', 'module', 'browser', 'development|production'],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
