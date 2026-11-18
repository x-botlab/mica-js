import { defineConfig } from '@mica-js/sdk/config';

/**
 * legacy widget 工程配置：默认读取 `src/`，输出到 `dist/`。
 *
 * 正式入口是 `.sch v2` 与 `workbench/` 宿主；本配置只供显式 `build:legacy` /
 * `build:widgets` 构建旧的板面 widget，不参与默认 `build`。
 */
export default defineConfig({});
