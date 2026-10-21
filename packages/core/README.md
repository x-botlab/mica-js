# @mica-js/core

Mica 仿真内核（虚拟时间与确定性事件调度），并提供原理图与 2D 视图的文档格式子路径。

## 入口

- `@mica-js/core`：仿真内核
- `@mica-js/core/schematic`：`.sch` / `.view` 文档格式

文件合同见 [x-botlab/mica-js#6](https://github.com/x-botlab/mica-js/issues/6)。

## 开发

```bash
pnpm --filter @mica-js/core run test
pnpm --filter @mica-js/core run typecheck
pnpm --filter @mica-js/core run build
```
