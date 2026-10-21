# @mica-js/core

Mica 仿真内核（虚拟时间与确定性事件调度），并提供原理图 `.sch` 与画布 `.cnv` 的文档格式子路径。

## 安装

```bash
pnpm add @mica-js/core
```

## 入口

| 入口                      | 内容                                              |
| ------------------------- | ------------------------------------------------- |
| `@mica-js/core`           | 仿真内核（虚拟时间与事件调度）                    |
| `@mica-js/core/schematic` | 原理图 `.sch`：解析、拓扑推导、编辑命令与属性系统 |
| `@mica-js/core/canvas`    | 画布 `.cnv`：与 `.sch` 绑定的 2D 摆放（`layout`） |

文件合同：`.sch` 见 [#6](https://github.com/x-botlab/mica-js/issues/6)，`.cnv` 见 [#67](https://github.com/x-botlab/mica-js/issues/67)。

## 原理图（`./schematic`）

```ts
import { loadSchematic, parseSchematic, serializeSchematic } from '@mica-js/core/schematic';

const loaded = loadSchematic(text, { devices }); // { document, topology }
const document = parseSchematic(text); // 解析 + 校验，失败抛 SchematicError
serializeSchematic(document); // 固定字段顺序的 .sch JSON
```

- 文件名即原理图标识，顶层没有 `id`；`symbols` / `wires` / `junctions` 使用不透明的稳定 `id`。
- 拓扑按位号、网名与连接关系合并网络；纯绘图分量保留为几何数据。
- 编辑命令、undo/redo、命中测试、导线段拖动与交点合并都是纯函数，编辑器只做编排。
- `createDeviceRegistry` 把器件的 `designatorPrefix` 与引脚声明合成为符号几何与位号。
- 属性（#7）：`string` / `number` / `integer` / `boolean` / `enum` / `color` / `image` / `binary`；`image` / `binary` 的值是资源引用 `{ src, mode }`（`file` 为工程根相对路径，`inline` 为 base64，`store` 为宿主资源标识）。

## 画布（`./canvas`）

```ts
import { loadCanvas, parseCanvas, serializeCanvas } from '@mica-js/core/canvas';

const canvas = parseCanvas(text); // version / id / schematic / layout
const { placements } = loadCanvas(canvas, { schematic: document }); // layout 键须属于该 .sch
serializeCanvas(canvas);
```

`layout` 以 symbol 的稳定 `id` 为键，值为 `{ x, y, rotation }`；引用绑定原理图中不存在的实例时报 `canvas/unknown-symbol`。原理图编辑器不依赖这个入口。

## 开发

```bash
pnpm --filter @mica-js/core run test
pnpm --filter @mica-js/core run typecheck
pnpm --filter @mica-js/core run build
```

## 相关提案

- 原理图格式：[#6](https://github.com/x-botlab/mica-js/issues/6)
- 属性定义：[#7](https://github.com/x-botlab/mica-js/issues/7)
- 画布格式：[#67](https://github.com/x-botlab/mica-js/issues/67)
