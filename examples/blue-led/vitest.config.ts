import { defineConfig } from 'vitest/config';

/**
 * 器件包自己的 vitest 配置。
 *
 * 从包目录向上查找会先碰到仓库根或上层目录的 `vitest.config.ts`，显式指定本文件可以
 * 避免加载与本工程无关的解析环境。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
