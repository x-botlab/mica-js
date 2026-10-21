# @mica-js/core

Mica 仿真内核（虚拟时间与确定性事件调度），并提供原理图与 2D 视图的文档格式子路径。

## 入口

- `@mica-js/core`：仿真内核
- `@mica-js/core/schematic`：`.sch` / `.view` 文档格式

文件合同：#6 规定原理图 `.sch`，#67 规定 2D 视图 `.view`。

属性值支持标量、`image` / `binary` 的资源引用 `{ "src", "mode" }`（#7）与 nullable 属性的显式 `null`；器件属性描述由 `readPropertyDescriptors` 解析，编辑命令按描述校验并归一化颜色。

## 开发

```bash
pnpm --filter @mica-js/core run test
pnpm --filter @mica-js/core run typecheck
pnpm --filter @mica-js/core run build
```
