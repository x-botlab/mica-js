import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { micaSandboxPlugins } from '../../packages/sandbox/vite.plugins';
import { micaWidgetPlugins } from '../../packages/widget/src/build/vite';

/** Resolve workspace packages from source so integration work shows up without a rebuild. */
export default defineConfig({
  // Guest workers are framework infrastructure; component artifacts come from the SDK CLI.
  plugins: [
    react({ exclude: [/node_modules/, /[/\\]packages[/\\]editor[/\\]src[/\\]fused[/\\]/] }),
    tailwindcss(),
    ...micaSandboxPlugins(),
    ...micaWidgetPlugins(),
  ],
  resolve: {
    conditions: ['source', 'module', 'browser', 'development|production'],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
