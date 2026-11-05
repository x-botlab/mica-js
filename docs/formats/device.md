# device.json 格式

器件元数据使用 JSON；作者产物以 [SDK 元数据契约](../../packages/sdk/README.md#json-元数据)为准，编辑器读取约束见 [device.schema.json](./device.schema.json)，采用 JSON Schema Draft 2020-12。所有结构对象拒绝未知字段；`properties`、`pins`、`ports`、`symbol.pins` 和选择项标签是键值映射。

## 器件与属性

必填字段为 `kind: "device"`、`id`、`version`、`displayName`；`properties`、`pins`、`ports` 三个映射均可省略，也允许为空，标准化时按空映射处理。`id` 仅含 ASCII 字母、数字和连字符，允许以数字或连字符开头，也允许仅由连字符组成；这些标识可用于 `<packageId>:<deviceId>` 引用，包命名空间规则保持不变。版本与显示名称为非空字符串，版本不要求语义版本格式。可选 `description`、`license` 为非空字符串，`tags` 是无重复的非空字符串数组，`designatorPrefix` 非空且不含空白。

属性描述包含 `type` 和布尔值 `required`。类型为 `number`、`boolean`、`string`、`enum` 或 `bytes`；`nullable` 控制实例值是否可为 `null`。`required: true` 禁止声明 `default`，其他默认值可为任意 JSON。`enum` 必须同时提供非空 `enumName` 和无重复、非空字符串组成的非空 `values` 数组；其他类型不得使用这两个字段。

`title`、`description`、`unit`、`group` 是可选字符串，`order` 是非负整数。可选 `editor` 以 `kind` 区分：`number` 可携带数值 `min`、`max` 和正数 `step`；`text`、`textarea`、`checkbox`、`file` 不含其他字段；`select` 可携带字符串映射 `labels`。编辑器配置本身不限制属性类型组合。

顶层引脚声明可含 `label`、`description`、`group`。端口必须声明 `direction: "input" | "output"` 和类型：`boolean`、`number`、`string`、`vec2d`、`vec3d`、`bytes`、`bytes<rgb565>`、`bytes<segments>`；可选 `title`、`description` 和 `delivery: "level" | "message"`。省略 `delivery` 时，布尔、数值和向量端口使用 `level`，字符串与字节端口使用 `message`。

```json
{
  "kind": "device",
  "id": "resistor",
  "version": "1.0",
  "displayName": "Resistor",
  "designatorPrefix": "R",
  "properties": {
    "resistance": {
      "type": "number",
      "required": false,
      "default": 1000,
      "unit": "Ohm",
      "editor": { "kind": "number", "min": 0, "step": 1 }
    }
  },
  "pins": { "A": { "label": "A" }, "B": { "label": "B" } },
  "ports": {}
}
```

## 自定义符号

省略 `symbol` 时根据引脚生成符号。声明时必须提供 `bounds`、`graphics` 和 `pins`。`bounds` 含数值 `x`、`y` 及正数 `width`、`height`；它是选中和命中区域，不会自动画成外框。

`graphics` 是图元数组，每项以 `type` 区分。公共可选字段为 `fill: "none" | "foreground" | "background"`（默认 `none`）和正数 `strokeWidth`。

| type       | 必填几何字段                                        | 其他可选字段             |
| ---------- | --------------------------------------------------- | ------------------------ |
| `line`     | `from`、`to` 坐标对                                 |                          |
| `polyline` | 至少两个坐标对组成的 `points`                       | `closed`，默认 `false`   |
| `rect`     | `x`、`y`、正数 `width`、`height`                    |                          |
| `circle`   | `center` 坐标对、正数 `radius`                      |                          |
| `arc`      | `center`、正数 `radius`、`startAngle`、`sweepAngle` |                          |
| `text`     | `position` 坐标对、`text` 字符串                    | `align`、正数 `fontSize` |

所有坐标对为 `[x, y]`。圆弧扫角非零且介于 -360 与 360 之间。`symbol.pins` 的每个引脚必须提供 `position` 和 `direction: "left" | "right" | "up" | "down"`；可选 `label` 必须含布尔值 `visible`，可选位置 `position` 与对齐 `align`。标题文字来自顶层对应引脚的 `label`。可选 `annotations.designator` 必须含 `position`，`align` 可省略。所有对齐值为 `left`、`center`、`right`。

编辑器渲染采用页面单位，x 向右、y 向下；角度为度数，零度沿 +x，正扫角顺时针。`foreground` 使用符号描边色，`background` 使用符号背景色。自定义图元取代自动外框、器件名称和引脚短线；空图元数组也遵循此规则。引脚标签未配置时默认可见，放在引脚短线靠器件本体的一端，并按引脚方向对齐（左右侧距本体边缘 2 单位，上下侧文字中心距边缘 5 单位）；显式标签位置和对齐覆盖默认布局，隐藏标签不渲染。位号位置未配置时由编辑器选择默认锚点。这些是编辑器渲染约定，不是额外的 Schema 约束。

## 文档包 API

`@mica-js/document/schematic` 导出 `DeviceMetadata`、`DeviceGraphic` 等只读类型和 `parseDeviceMetadata(input)`。解析器接受 JSON 文本或对象，拒绝非法输入并抛出带 JSON Pointer 诊断的 `SchematicError`，不修改输入、不注入 Schema 默认值。

注册器通过注册项的 `raw.kind === "device"` 识别新格式并严格验证，注册项 `id` 必须与元数据一致。新格式的显示名称、描述、前缀与符号来自元数据；旧格式注册仍保留；显式 `entry.symbol` 中的自定义图元、位号注释、引脚标签与显示名称也会保留。注册按包原子提交。

`deviceMetadataSymbol` 将坐标对转为现有引脚锚点，`up/down` 转为 `top/bottom`；保留 `graphics`、标签和位号注释。`deviceMetadataPropertyDescriptors` 保留 `required`、编辑器、分组、顺序，枚举转为带标签的选项，`bytes` 转为现有 `binary` 资产类型。仅符合实例属性约束的默认值进入标准化描述，原始元数据仍完整保留。文件值继续使用文档既有的内联或外部资产引用，不直接把任意 JSON 当作二进制内容。
