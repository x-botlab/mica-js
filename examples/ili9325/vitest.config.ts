import { defineConfig } from 'vitest/config';

/** 器件包自己的 vitest 配置：每块板都会重新翻译模型，文件串行执行。 */
export default defineConfig({
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: [/@mica-js\//] } },
    fileParallelism: false,
    testTimeout: 900_000,
  },
});
