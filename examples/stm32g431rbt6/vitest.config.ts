import { defineConfig } from 'vitest/config';

/**
 * 器件包自己的 vitest 配置。
 *
 * 每个用例都会新建一块板并翻译指令块，并发只会互相抢线程，因此文件串行执行。
 */
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
