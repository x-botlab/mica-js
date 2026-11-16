import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：源在 src/ 与 views/，共享 outDir 默认输出 dist/lm386/。 */
export default defineConfig({
  outDir: '../dist',
  device: {},
});
