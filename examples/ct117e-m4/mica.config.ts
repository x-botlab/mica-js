import { defineConfig } from '@mica-js/sdk/config';

/** 单器件开发项目：显式清单/DDL，产物写入本包 `dist/`。 */
export default defineConfig({
  device: { manifest: 'package.json', model: 'src/model.ddl' },
});
