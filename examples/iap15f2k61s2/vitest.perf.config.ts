import { defineConfig } from 'vitest/config';

/**
 * 性能基准专用配置：只在显式运行 `pnpm run bench` 时装载 `bench/`，不进常规用例。
 *
 * 基准必须独占 CPU 才能读数稳定，因此串行执行、超时时间放宽到基准量级。
 */
export default defineConfig({
  test: {
    include: ['bench/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 1_800_000,
  },
});
