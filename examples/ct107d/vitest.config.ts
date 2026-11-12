import { defineConfig } from 'vitest/config';

/**
 * 器件包自己的 vitest 配置。
 *
 * 用例直接装载 `src/` 里的适配器并现场编译 `model.ddl`，因此解析时必须优先走各包的
 * `source` 导出，而不是已构建的 `dist`。每个用例都会新建一块板并翻译指令块，并发只会
 * 互相抢线程，所以文件串行执行。
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
