---
'@mica-js/sdk': minor
---

`mica build --watch` 持续构建统一器件包：首次完整构建后监听 `sourceDir`、清单、DDL 与 `mica.config.ts`，防抖串行重建，配置或 `sourceDir` 改动后重新加载并重定向监听。构建先写入临时目录再整体替换 `outDir`，失败时保留上一份完整产物并继续监听，成功时输出带 `id@version` 与 integrity 的单行摘要。
