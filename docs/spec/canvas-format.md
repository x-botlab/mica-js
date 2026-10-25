# canvas 格式（.cnv）

> **状态**：提案（OPEN） · **来源**：[#67](https://github.com/x-botlab/mica-js/issues/67) · **同步**：2026-10-25
> **实现**：[`packages/core/src/canvas/format/`](../../packages/core/src/canvas/format/)
> **相关**：[原理图格式](./schematic-format.md) · [Widget 定义](./widget-definition.md) · [Widget JavaScript API](./widget-js-api.md) · [属性定义](./device-properties.md) · [话题端口](./topic-ports.md)

canvas 使用 `.cnv` 文件描述，是一张独立的 2D 画布：记录画布上的 widget 实例，以及实例的摆放、属性覆盖与端口到器件端点的绑定。画布为无限平面，尺寸与视口由宿主按需映射，格式层只保存实例坐标。文件采用 UTF-8 JSON，`version` 固定为整数 `1`。

canvas 与原理图相互独立：`.sch` 保存电气拓扑与原理图自身的绘图坐标，`.cnv` 保存 widget 摆放，两者之间没有坐标映射。`.cnv` 用可选的 `schematic` 字段声明仿真绑定，把这些 widget 接到某个原理图对应的仿真上。

典型用法是用内置图片 widget 承载设备照片，再在其上覆盖透明 widget（数码管、按键、跳线／开关等），把这些 widget 的端口绑定到等效仿真原理图中器件的端口。

## 与原理图的关系

- 多对一：同一 `.sch` 可被零个、一个或多个 `.cnv` 绑定；每个 `.cnv` 最多绑定一个 `.sch`。
- `schematic` 只声明仿真绑定，实例摆放与原理图图元相互独立；原理图 symbol 的 `id` 与 canvas 实例 `id` 分属不同作用域。
- 同一 `.cnv` 的全部 widget 共享该绑定；不同 `.cnv` 各自保存自己的摆放与绑定。
- 绑定以 `(symbol id, 端口键)` 端点表达，格式层不含话题名；通道标识由宿主从端点推导。
- 多个 widget 可以指向同一端点，构成扇出；引用只在本文档内解析。
- 省略 `schematic` 时，`.cnv` 只描述摆放；`bindings` 仍作为文档数据保存，端点引用在装载期跳过解析。

## 顶层字段

| 字段        | 类型      | 必填 | 说明                                                                  |
| ----------- | --------- | ---- | --------------------------------------------------------------------- |
| `version`   | `integer` | 是   | 格式版本，固定为 `1`                                                  |
| `schematic` | `string`  | 否   | 仿真绑定的原理图路径，由宿主按自身规则解析；格式层只要求非空字符串    |
| `widgets`   | `array`   | 是   | widget 实例数组，允许空数组；数组顺序即绘制顺序，靠后的实例绘制在上层 |

canvas 以宿主工程内的 POSIX 相对路径作为标识，文件可位于工程内任意目录。`schematic` 是交给宿主解析的不透明路径：可以相对 `.cnv`、相对工程根，也可以包含 `..`，宿主能接受即可，格式层不限制其形态。

## widget 实例字段

| 字段         | 类型     | 必填 | 说明                                                                     |
| ------------ | -------- | ---- | ------------------------------------------------------------------------ |
| `id`         | `string` | 是   | 实例稳定标识，UUID v4，在文档内唯一                                      |
| `widget`     | `string` | 是   | widget 引用 `"<包ID>:<WidgetID>"`；内置 widget 使用 `builtin:<WidgetID>` |
| `x`          | `number` | 是   | 左上角横坐标，有限数值，逻辑单位                                         |
| `y`          | `number` | 是   | 左上角纵坐标，有限数值，逻辑单位                                         |
| `width`      | `number` | 是   | 宽度，有限正数，逻辑单位                                                 |
| `height`     | `number` | 是   | 高度，有限正数，逻辑单位                                                 |
| `rotation`   | `number` | 是   | 旋转角，单位度，顺时针为正，以实例中心为旋转原点                         |
| `properties` | `object` | 否   | 属性覆盖，键取自 widget 定义；值规则见[属性定义](./device-properties.md) |
| `bindings`   | `object` | 否   | 端口键到绑定端点的映射，值为 `{ "symbol", "port" }`                      |

`builtin` 是保留命名空间，内置 widget 由加载器识别，清单由 [Widget 定义](./widget-definition.md)维护。其他包 ID 由宿主按其依赖声明解析。

### 坐标与绘制

- 画布是无限平面，`x` 向右、`y` 向下；坐标单位为逻辑单位，1 单位等于 100% 缩放下 1 个显示像素，宿主按缩放映射。
- 渲染区域即 `(x, y)`、`width`、`height` 确定的矩形；`rotation` 绕矩形中心顺时针旋转，取值任意有限数，渲染时归一化到 `[0, 360)`。
- 绘制顺序取 `widgets` 数组顺序，靠后的实例覆盖靠前的实例；同一文档内顺序即层级，不引入分组字段。
- 数组顺序参与确定性处理，实例按文档顺序与 `id` 稳定可重放。
- 视口、吸附、对齐等编辑辅助与画布背景、网格属宿主状态，不写入文档；canvas 之间不嵌套引用。

### 属性与绑定

- `properties` 保存实例覆盖值，缺省键取 widget 定义的默认值。
- image／binary 属性使用资源引用对象 `{ "src", "mode" }`：`mode` 为 `file` 时 `src` 是工程内 POSIX 相对路径，另有 `inline`（base64）与 `store`（宿主资源标识）；文档保存引用本身，绝对路径与网络地址由宿主映射。
- `bindings` 显式保存端口到端点的映射；出现的端口参与消息投递，缺省的端口保持静默。
- 端点形如 `{ "symbol": "<symbol id>", "port": "<端口键>" }`：`symbol` 指向绑定原理图中的器件实例，`port` 是该器件声明的端口键。
- **绑定目标只能是器件端口**：widget 与 widget 之间不直接绑定，需要串联时经器件端口中转；跨 canvas 通信不进入格式。
- 格式层不含话题名；宿主以 `(symbol id, 端口键)` 推导通道标识，编解码与调度由通信合同定义。
- 端点在编辑器中显示为 `<位号>.<端口>` 的人类可读别名，别名属展示层，不写入文档。
- 多个 widget 指向同一端点即扇出；同一端口只可绑定一个端点。
- 绑定随实例保存在 `.cnv`，修改绑定只改该文档，原理图文件保持原样。

## 示例

```json
{
  "version": 1,
  "schematic": "boards/ct107d.sch",
  "widgets": [
    {
      "id": "3f6c1e28-9b47-4d05-8a71-2c5e0f9b6d13",
      "widget": "builtin:image",
      "x": 0,
      "y": 0,
      "width": 1024,
      "height": 762,
      "rotation": 0,
      "properties": { "image": { "src": "assets/ct107d-board.webp", "mode": "file" } }
    },
    {
      "id": "a17d5b90-4e2c-4f86-b3d9-7e1c8a2f5046",
      "widget": "zerobit:segment-display",
      "x": 512,
      "y": 214,
      "width": 196,
      "height": 60,
      "rotation": 0,
      "properties": { "digits": 8 },
      "bindings": {
        "value": { "symbol": "5b8e2f14-9c03-4d7a-b6e1-2f4c8a9d0e57", "port": "segments" }
      }
    },
    {
      "id": "c92b0d47-6a18-4e53-9f20-8d4b7e1a3c05",
      "widget": "zerobit:keypad-key",
      "x": 132,
      "y": 470,
      "width": 44,
      "height": 44,
      "rotation": 0,
      "bindings": {
        "press": { "symbol": "8d41c6b2-7e59-4a30-95f8-1c6b3e2a7d04", "port": "key" }
      }
    }
  ]
}
```

示例中的 `{ "symbol", "port" }` 为绑定端点：`symbol` 是绑定原理图中的器件 symbol `id`（`5b8e…` 为数码管、`8d41…` 为按键阵列），`port` 是该器件声明的端口键。内置 widget 的 `properties` 键（如 `image`）由 Widget 定义声明。

## 校验

- 单个完整 JSON 对象，键唯一，字段属于对应 schema 且值类型匹配；`version` 为整数 `1`，版本校验错误返回结构化诊断。
- 实例 `id` 为 UUID v4 且在文档内唯一：重复返回 `id/duplicate`，非 UUID v4 返回 `schema/invalid-value`。
- 包 ID、Widget ID、属性键与端口键统一采用 `[a-z0-9][a-z0-9-]*`（kebab-case），不符合返回 `schema/invalid-value`；`builtin` 为保留命名空间。
- 实例 `widget` 解析为有效 widget 定义或内置 widget，无法解析返回 `canvas/unknown-widget`。
- `schematic` 出现时指向本次已加载的有效 `.sch`，无法解析返回 `canvas/unknown-schematic`；省略时跳过引用校验。
- `properties` 的键由 widget 定义声明，值符合属性类型与资源引用规则；未知键返回 `canvas/unknown-property`，类型或编码错误返回 `schema/invalid-value`。
- `bindings` 的键由 widget 定义的 `ports` 声明，未知端口返回 `canvas/unknown-port`；值为对象，只含非空字符串 `symbol` 与非空字符串 `port`，出现其他键返回 `schema/unknown-field`。
- 绑定端点解析失败返回结构化诊断：`symbol` 不在绑定原理图中返回 `canvas/unknown-symbol`；目标器件未声明该端口返回 `canvas/unknown-target-port`。
- 端点方向与载荷类型按[话题端口](./topic-ports.md)校验，方向不符或类型不可赋值返回 `topic/type-mismatch`。
- 省略 `schematic` 时跳过端点解析，只校验 `bindings` 的结构。
- `.cnv` 与 `.sch` 各自独立版本，不做联合版本校验；`.sch` 结构变化导致 symbol 消失时，装载期报 `canvas/unknown-symbol`，绑定原样保留，由编辑器提示修复。
- 几何字段为有限数值，`width`、`height` 为正数；几何错误保留原始值并返回结构化诊断。
- 加载按文件路径确定性排序，实例按文档顺序处理，结果与文件系统枚举顺序无关。
