import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：发布包写到 ../dist/mcp4017/。 */
export default defineConfig({
  outDir: '../dist',
  device: {},
});
