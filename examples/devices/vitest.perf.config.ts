import { defineConfig } from 'vitest/config';

/** 器件库性能基准配置：只装载 `bench/`，串行执行并放宽超时。 */
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
