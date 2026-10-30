import { defineConfig } from 'vitest/config';

// This isolated numerical probe needs no sandbox bundle or package build.
export default defineConfig({
  resolve: { conditions: ['source', 'module', 'development|production'] },
  ssr: { resolve: { conditions: ['source', 'module', 'development|production'] } },
  test: {
    environment: 'node',
    include: ['bench/resistive-number.bench.ts'],
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
