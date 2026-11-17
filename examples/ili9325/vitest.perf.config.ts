import { defineConfig } from 'vitest/config';

/** 性能基准专用配置：只在显式运行 `pnpm run bench` 时装载 `bench/`。 */
export default defineConfig({
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['bench/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: [/@mica-js\//] } },
    fileParallelism: false,
    testTimeout: 1_800_000,
  },
});
