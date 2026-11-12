import { defineConfig } from 'vitest/config';

/**
 * 器件包自己的 vitest 配置。
 *
 * 从包目录向上查找会先碰到 Laravel 应用层的 `vitest.config.ts`（它指向 resources/js，
 * 而且依赖那边的解析环境），显式指定本文件可以避免加载它。
 *
 * 每个用例都会新建一块板，而块级翻译与电气求解都很吃 CPU：并发跑多个测试文件会互相
 * 抢线程、把本来几十秒的用例拖成超时，因此这里让文件串行执行。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // 差分用例要跑上百块板，单文件内的用例本身就可能有几分钟。
    testTimeout: 900_000,
  },
});
