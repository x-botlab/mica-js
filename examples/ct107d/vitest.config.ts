import { defineConfig } from 'vitest/config';

/**
 * CT107D 整板示例的 vitest 配置。
 *
 * 器件来自 `examples/devices`，用例通过相对路径直接装载器件源码；解析时优先走各包的
 * `source` 导出。每个用例都会新建一块板并翻译指令块，并发只会互相抢线程，所以文件串行执行。
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
