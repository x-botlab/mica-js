import { defineConfig } from 'vitest/config';

/** 器件包自己的 vitest 配置；显式指定可以避免向上加载与本工程无关的环境。 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
