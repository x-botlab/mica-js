# device.json 格式

`device.json` 描述器件的身份、属性面板、引脚、数据端口、原理图符号及平台集成信息，与对应的 `device.js` 一起交付。仿真行为由 DDL 和适配器实现，JSON 不包含可执行逻辑。组件工程和 CLI 用法见 [SDK 使用指南](../../packages/sdk/README.md)。

[device.schema.json](./device.schema.json) 采用 JSON Schema Draft 2020-12，描述文档读取格式。所有结构对象拒绝未知字段；`properties`、`pins`、`ports`、`symbol.pins` 和选择项标签是键值映射。SDK 构建还会检查默认值与声明类型是否一致、枚举默认值是否属于候选值等作者约束。

## 顶层字段

| 字段               | 必填 | 含义与约束                                                                 |
| ------------------ | ---- | -------------------------------------------------------------------------- |
| `kind`             | 是   | 固定为 `"device"`，区分器件与 Widget 元数据                                |
| `id`               | 是   | 组件局部 ID，仅含 ASCII 字母、数字和连字符；构建时必须与器件目录名一致     |
| `version`          | 是   | 非空版本字符串，格式不强制为语义版本；推荐使用 `1.0.0` 等语义版本          |
| `displayName`      | 是   | 用户可见名称，不作为器件身份或绑定键                                       |
| `description`      | 否   | 器件说明；文档格式要求非空字符串                                           |
| `license`          | 否   | 许可说明字符串，例如 `MIT`；文档格式要求非空，不校验 SPDX 标识             |
| `tags`             | 否   | 分类、搜索标签；无重复的非空字符串数组                                     |
| `designatorPrefix` | 否   | 位号前缀，例如电阻的 `R`、MCU 的 `U`；非空且不能包含空白，不是具体实例位号 |
| `templates`        | 否   | 支持创建项目的平台模板 ID 列表，见下节                                     |
| `recommends`       | 否   | 推荐组件信息，目前支持 `widgets`                                           |
| `properties`       | 否   | 属性名到属性描述的映射                                                     |
| `pins`             | 否   | 引脚 ID 到引脚描述的映射                                                   |
| `ports`            | 否   | 数据端口名到端口描述的映射，与电气引脚分开                                 |
| `symbol`           | 否   | 原理图自定义符号；省略时根据引脚生成符号                                   |

`properties`、`pins`、`ports` 可以省略或为空，使用时按空映射处理。`id` 允许以数字或连字符开头；跨组件引用使用完整的 `<packageId>:<deviceId>`，而不是显示名称。

## 项目模板与推荐组件

```json
{
  "templates": ["platform:c51", "platform:arm-gcc"],
  "recommends": {
    "widgets": ["demo:led-indicator", "demo:voltmeter"]
  }
}
```

`templates` 用于 MCU 等支持创建项目的器件。每项是平台项目模板的稳定 ID，不是模板文件路径、npm 包名或工具链命令。平台负责查找模板并提供创建项目操作；模板内容、工具链安装和生成参数由平台管理。

`recommends.widgets` 使用完整 Widget ID，供平台在选择器件或添加配套界面时展示推荐项。推荐不表示端口已绑定，也不触发自动添加、安装或仿真执行。

两个数组均可省略或为空，每项为非空字符串且不能重复，顺序表示展示优先级，不代表自动选择首项。`recommends` 及其 `widgets` 字段也可以分别省略。无法解析的模板或推荐项不应阻止器件加载和仿真，平台可以隐藏不可用项或显示不可用状态。Schema 仅检查字符串及结构，不访问平台目录验证目标是否存在，也不限定模板 ID 的命名空间语法。

## 属性 properties

键是实例属性名，例如 `resistance`，应与 DDL 或适配器使用的属性名一致；显示名称由 `title` 设置，不改变键。

| 字段          | 必填     | 含义                                                                            |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `type`        | 是       | `number`、`boolean`、`string`、`enum` 或 `bytes`                                |
| `required`    | 是       | 为 `true` 时由实例显式提供，禁止声明元数据 `default`；为 `false` 时可使用默认值 |
| `nullable`    | 否       | 是否允许实例值为 `null`；省略时不允许，`null` 不等于移除属性覆盖                |
| `default`     | 否       | 实例未覆盖时使用的默认值；作者应与 DDL 默认值保持一致                           |
| `enumName`    | 枚举必填 | 枚举类型名称，不是当前选中值                                                    |
| `values`      | 枚举必填 | 枚举候选值，非空数组，元素为无重复的非空字符串；顺序供选项展示使用              |
| `title`       | 否       | 属性面板显示名称                                                                |
| `description` | 否       | 属性说明，例如含义、使用条件和注意事项                                          |
| `unit`        | 否       | 展示单位，例如 `ohm`、`Hz`；不做数值换算                                        |
| `group`       | 否       | 属性面板分组提示                                                                |
| `order`       | 否       | 非负整数，供宿主进行展示排序；省略时采用宿主默认顺序                            |
| `editor`      | 否       | 输入控件及其参数，见下节                                                        |

`enumName` 与 `values` 仅用于 `enum`，其他类型不能声明。SDK 构建要求默认值匹配 `type`，枚举默认值必须属于 `values`；`default: null` 需要同时设置 `nullable: true`。`bytes` 的 JSON 默认编码尚未定义，SDK 不接受其 `default`。文档读取 Schema 的 `default` 则保留为任意 JSON，以兼容原始元数据；转换为属性面板数据时仅采用符合实例属性约束的默认值。

### editor 控件

`editor` 是一个对象，必须有 `kind`。它描述属性面板的输入方式，不修改属性类型、运行逻辑或 DDL 约束。宿主负责实现控件；声明提示不意味着所有宿主都具备该控件。省略时由宿主根据属性类型选择。

| `kind`     | 常用属性类型 | 参数与行为                                                                    |
| ---------- | ------------ | ----------------------------------------------------------------------------- |
| `number`   | `number`     | 数字输入；可选 `min`、`max` 为数值边界，`step` 为正数步长，单位与属性一致     |
| `text`     | `string`     | 单行文本输入，仅包含 `kind`                                                   |
| `textarea` | `string`     | 多行文本输入，仅包含 `kind`                                                   |
| `checkbox` | `boolean`    | 布尔勾选控件，仅包含 `kind`                                                   |
| `select`   | `enum`       | 下拉选择；`labels` 将真实选项值映射为展示文字，实际保存的仍是 `values` 中的值 |
| `file`     | `bytes`      | 文件选择；可选 `extensions` 和 `maxSize`，宿主将文件保存为文档支持的资产引用  |

文档读取 Schema 不限制 `editor.kind` 与属性类型的组合，作者应使用上表对应关系。SDK 的 TypeScript 类型提供更窄的组合约束；`bytes` 属性可以通过 `editor.kind: "file"` 声明文件输入。

数字控件的 `min`、`max`、`step` 是 UI 提示，不能替代 DDL 的 `assert` 或适配器校验。省略边界或步长时由宿主决定默认行为；Schema 不检查 `min <= max`，作者应保持它们合理。

```json
{
  "editor": { "kind": "number", "min": 1, "max": 1000000, "step": 1 }
}
```

下拉框示例：

```json
{
  "type": "enum",
  "required": false,
  "enumName": "ClockSource",
  "values": ["internal", "external"],
  "default": "internal",
  "editor": {
    "kind": "select",
    "labels": { "internal": "内部时钟", "external": "外部时钟" }
  }
}
```

文档读取格式允许省略 `select.labels`，未设置的选项可由宿主直接显示真实值；SDK 作者格式要求显式提供 `labels`，无需自定义文字时可填空对象。`labels` 的值必须是字符串，不用于声明候选项或改变存储值。

### 文件选择限制

```json
{
  "type": "bytes",
  "required": true,
  "editor": {
    "kind": "file",
    "extensions": [".bin", ".hex"],
    "maxSize": 1048576
  }
}
```

- `extensions`：可选且无重复的字符串数组，每项包含前导点，例如 `.bin`、`.hex`、`.tar.gz`。点后的各段使用 ASCII 字母或数字，也可用连字符分隔。省略或空数组表示不限制扩展名。宿主按完整文件名后缀匹配，忽略大小写；`.bin` 也匹配 `firmware.BIN`。JSON Schema 的重复检查按原字符串比较，作者不应同时列出仅大小写不同的扩展名。
- `maxSize`：可选正整数，单位为字节，表示选择文件时的原始文件大小上限，包含等于上限的情况；`1048576` 表示 1 MiB。省略表示不设置大小上限，不包含资产引用或编码后的存储开销。

宿主应在选择、拖入或替换文件时应用这些限制，超出限制时给出说明并保留原属性值。文件选择器的筛选只能辅助选择，宿主仍需在接受文件前检查；这些元数据不会让 SDK 或仿真运行时自动读取、筛选文件。扩展名不证明内容有效，实际固件格式仍由器件实现检查。文件内容通过文档既有的资产引用机制交付，不直接写入元数据 `default`。

### 完整属性示例

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

## 引脚 pins

`pins` 的键是电气引脚 ID，对应 DDL 的引脚名和 `symbol.pins` 的键。每个描述对象允许为空。

| 字段          | 含义                                                            |
| ------------- | --------------------------------------------------------------- |
| `label`       | 用户可见的引脚名称；符号标签显示该文字，不改变用于连接的引脚 ID |
| `description` | 引脚说明，例如电气用途                                          |
| `group`       | 分组提示，例如 `GPIO`、`Power`，不改变电气连通关系              |

顶层引脚描述不设置几何位置；位置、方向和标签可见性放在 `symbol.pins`。例如 GPIO 的引脚 ID 可以为 `pa0`，显示名称为 `PA0 / ADC0`。

## 数据端口 ports

数据端口用于器件与 Widget 的话题绑定，不是电气连线。`direction` 以器件为参照：`input` 接收数据，`output` 发布数据。端口键应与实现中使用的名字一致。

| 字段          | 必填 | 含义                                                                           |
| ------------- | ---- | ------------------------------------------------------------------------------ |
| `direction`   | 是   | `input` 或 `output`                                                            |
| `type`        | 是   | 负载类型，见下表                                                               |
| `title`       | 否   | 面板中的显示名称，不改变绑定所用端口名                                         |
| `description` | 否   | 数据含义、单位或协议说明                                                       |
| `delivery`    | 否   | `level` 表示当前状态，`message` 表示逐条交付的消息；省略时按负载类型选取默认值 |

| `type`            | 数据含义        | 默认 `delivery` |
| ----------------- | --------------- | --------------- |
| `boolean`         | 布尔状态        | `level`         |
| `number`          | 数值            | `level`         |
| `vec2d`、`vec3d`  | 二维、三维向量  | `level`         |
| `string`          | 文本            | `message`       |
| `bytes`           | 原始字节        | `message`       |
| `bytes<rgb565>`   | RGB565 字节负载 | `message`       |
| `bytes<segments>` | 段显示字节负载  | `message`       |

具体字节编码、尺寸和协议由实现及端口约定决定，元数据不会自动转换负载。

```json
{
  "ports": {
    "brightness": { "direction": "output", "type": "number", "delivery": "level" },
    "serialRx": { "direction": "input", "type": "bytes", "delivery": "message" }
  }
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
