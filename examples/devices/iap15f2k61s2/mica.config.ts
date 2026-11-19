import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：显式清单/DDL，输出到聚合库的 `dist/iap15f2k61s2/`。 */
export default defineConfig({
  outDir: '../dist/iap15f2k61s2',
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
