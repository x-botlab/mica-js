import { defineConfig } from '@playwright/test';

/**
 * Smoke tests for the host integration: they drive the real playground page against the dev
 * server, which also exposes the mounted editor as `globalThis.mica` in dev builds.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    // `--host 127.0.0.1` matters: Vite otherwise binds IPv6-only, and the health check below
    // would never connect.
    command: 'pnpm exec vite --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
