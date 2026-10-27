import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Standalone config: extending the playground config would inherit its web server, whose relative
// working directory resolves against this directory instead of `apps/playground`.
export default defineConfig({
  testDir: '.',
  testMatch: 'sandbox-rpc.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command:
      'pnpm exec vite --config e2e/sandbox-rpc.config.ts --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175/e2e/fixtures/sandbox-rpc.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
