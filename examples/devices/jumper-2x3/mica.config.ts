import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：显式清单/DDL，输出到聚合库的 `dist/jumper-2x3/`。 */
export default defineConfig({
  outDir: '../dist/jumper-2x3',
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
