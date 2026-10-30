import { defineConfig } from 'vitest/config';

// Plain timed loops over the public `Circuit` facade; no Vitest bench harness and no package build.
export default defineConfig({
  resolve: { conditions: ['source', 'module', 'development|production'] },
  ssr: { resolve: { conditions: ['source', 'module', 'development|production'] } },
  test: {
    environment: 'node',
    include: ['bench/electrical-circuit.bench.ts'],
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
