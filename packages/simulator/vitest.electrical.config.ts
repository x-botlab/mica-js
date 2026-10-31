import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source', 'module', 'development|production'] },
  ssr: { resolve: { conditions: ['source', 'module', 'development|production'] } },
  test: {
    environment: 'node',
    include: [
      'src/public-api.test.ts',
      'src/electrical*.test.ts',
      'src/unified-ir/**/*.test.ts',
      'src/host/**/*.test.ts',
    ],
  },
});
