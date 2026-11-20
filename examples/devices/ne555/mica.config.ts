import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：显式清单/DDL，输出到聚合库的 `dist/ne555/`。 */
export default defineConfig({
  outDir: '../dist/ne555',
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
