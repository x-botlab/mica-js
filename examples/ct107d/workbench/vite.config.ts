import { micaSandboxPlugins } from '@mica-js/sandbox/vite';
import { micaWidgetPlugins } from '@mica-js/widget/vite';
import { defineConfig } from 'vite';

/**
 * CT107D workbench host.
 *
 * The host consumes workspace packages from source, so the sandbox worker plugin is required in
 * dev and build. HTML views are deployed as a real same-directory environment and are reached
 * through a `*.localhost` origin; `allowedHosts` keeps Vite from rejecting those Host headers.
 */
export default defineConfig({
  plugins: [...micaSandboxPlugins(), ...micaWidgetPlugins()],
  resolve: {
    conditions: ['source', 'module', 'browser', 'development|production'],
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    allowedHosts: ['.localhost'],
  },
  preview: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
    allowedHosts: ['.localhost'],
  },
  build: {
    target: 'es2022',
  },
});
