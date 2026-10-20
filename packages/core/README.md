# @mica/core

Mica 仿真内核（虚拟时间与确定性事件调度），并提供原理图与 2D 视图的文档格式子路径。

## 入口

- `@mica/core`：仿真内核
- `@mica/core/schematic`：`.sch` / `.view` 文档格式

文件合同见 [x-botlab/mica-js#6](https://github.com/x-botlab/mica-js/issues/6)。

## 开发

```bash
pnpm --filter @mica/core run test
pnpm --filter @mica/core run typecheck
pnpm --filter @mica/core run build
```
