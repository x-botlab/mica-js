import { defineConfig } from '@mica-js/sdk/config';

/**
 * 单器件工程：读取根 package.json 清单、`src/model.ddl` 与 `src/index.ts`，
 * 输出到聚合库的 `examples/devices/dist/<id>/`。
 */
export default defineConfig({ outDir: '../dist', device: {} });
