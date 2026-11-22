---
'@mica-js/sdk': minor
---

新增 `mica pack`：不重新构建，只把已有统一器件包按 `release.json` 的文件表打成确定性 ZIP（路径排序、store-only、固定时间戳），`release.json` 位于包根且不计入发布身份。`outDir` 缺失、缺少 `release.json` 或任一文件与记录不一致时直接失败且不产出 ZIP；默认输出 `<root>/<publisher>-<name>-<version>.zip`，可用 `--out` 覆盖。
