import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：源在 src/，共享 outDir 默认输出 dist/ir-emitter/。 */
export default defineConfig({
  outDir: '../dist',
  device: {},
});
