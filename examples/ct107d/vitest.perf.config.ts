import { defineConfig } from 'vitest/config';

/**
 * 性能基准专用配置：只在显式运行 `pnpm run bench` 时装载 `bench/`，不进常规用例。
 *
 * 基准必须独占 CPU 才能读数稳定，因此串行执行、超时时间放宽到基准量级。
 * 与另外两个示例的差异只有解析条件：`bench/board.ts` 直接装载 `src/` 里的适配器并现场
 * 编译 `model.ddl`（同 `test/harness.ts`），所以必须优先走各包的 `source` 导出。
 */
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
