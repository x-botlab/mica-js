import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：显式清单/DDL，输出到聚合库的 `dist/cx20106a/`。 */
export default defineConfig({
  outDir: '../dist/cx20106a',
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
