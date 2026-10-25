# 属性定义

> **来源**：[#7](https://github.com/x-botlab/mica-js/issues/7) · **同步**：2026-10-25
> **实现**：[`packages/device/src/properties.ts`](../../packages/device/src/properties.ts) · [`packages/core/src/format/value.ts`](../../packages/core/src/format/value.ts)
> **相关**：[Widget 定义](./widget-definition.md) · [话题端口](./topic-ports.md) · [原理图格式](./schematic-format.md) · [Canvas 格式](./canvas-format.md)

属性表达实例的持久配置。Widget 与器件在各自的核心描述中定义属性字段，并引用本文的规则；运行状态由状态合同描述，通信消息由话题端口描述。

## 属性描述

属性描述是对象：

| 字段          | 约束                                             |
| ------------- | ------------------------------------------------ |
| `type`        | 必填，取自下方类型表                             |
| `title`       | 可选，展示名称；省略时消费方使用属性键           |
| `description` | 可选，展示说明                                   |
| `default`     | 可选，满足类型与约束的默认值；省略表示没有默认值 |
| `nullable`    | 可选，默认 `false`；`true` 时允许显式 `null`     |

| 类型      | 值                 | 附加字段                                     |
| --------- | ------------------ | -------------------------------------------- |
| `string`  | 字符串             | `maxLength`                                  |
| `integer` | 安全整数           | `min`、`max`、`step`                         |
| `number`  | 有限数值           | `min`、`max`、`exclusiveMin`、`step`、`unit` |
| `boolean` | 布尔值             | 无                                           |
| `color`   | `#RRGGBBAA` 字符串 | `alpha`                                      |
| `enum`    | 字符串选项值       | `options`                                    |
| `image`   | 资源引用           | `maxBytes`、`maxPixels`                      |
| `binary`  | 资源引用           | `maxBytes`                                   |

描述无法使用时，消费方忽略该属性而不是猜类型：`type` 未知、`enum` 缺少有效 `options`、选项 `value` 重复时不渲染该属性；`default` 不满足自身约束时按未声明默认值处理，不写入非法值。

```json
{ "type": "number", "title": "惯量", "default": 1, "exclusiveMin": 0 }
```

### 数值、字符串与缺省

- `min`、`max` 为闭区间边界，`exclusiveMin` 为开区间下界；`min` 与 `exclusiveMin` 二选一，上下界构成合法区间。
- `integer` 使用安全整数，`number` 使用有限数值。
- `step` 为大于零的编辑步长；保存值按属性的类型与范围校验。
- `unit` 是显示单位，保存值使用声明约定的单位。
- `maxLength` 按 Unicode 码点计数。长度与资源上限必须为非负整数。
- 缺省值应用 `default`；显式 `null` 在 `nullable` 为 `true` 时保留。
- 属性声明的资源额度以宿主全局上限为界。

### 颜色与枚举

颜色归一化为大写 `#RRGGBBAA`。`alpha` 默认 `false`，此时透明度为 `FF`；`alpha` 为 `true` 时可声明透明度。

`options` 为非空数组，每项含字符串 `value` 与展示用 `label`；`value` 唯一，字符串默认值属于选项集合，`nullable` 为 `true` 时也可以使用 `null`。

### 图片与二进制

`image` 与 `binary` 的值是**资源引用**，默认引用宿主文件，不内联字节：

```json
{ "src": "assets/logo.png", "mode": "file" }
```

| 字段   | 约束                                 |
| ------ | ------------------------------------ |
| `src`  | 必填，非空字符串；含义由 `mode` 决定 |
| `mode` | 必填，`file` / `inline` / `store`    |

- `file`：`src` 是工程内的 POSIX 相对路径。禁止绝对路径、盘符、`..` 段、`~`、反斜杠与任何 URL scheme。路径由宿主按其工程根解析，格式层不定义工程根的判定方式。
- `inline`：`src` 是 base64 文本，仅在宿主显式内联时使用（单文件导出、示例、小图标）。
- `store`：`src` 是宿主资源库标识，编解码与寻址由宿主定义，用于去重与统一管理。

引用不记录内容哈希与媒体类型：格式层只表达「指向哪里」。图片格式由宿主按内容判定，内容变更是否影响仿真由宿主策略决定。`image` 受 `maxBytes`、`maxPixels` 约束，`binary` 受 `maxBytes` 约束，宿主在读取阶段按限额拦截。

宿主解析时以自身工程根为边界，拒绝越界路径与符号链接逃逸，且不进行任何网络读取；引用缺失、越界、超限或无法解码时由宿主报告错误，建议错误码为 `asset/missing`、`asset/out-of-root`、`asset/too-large`、`asset/undecodable`。`default` 与实例值使用同一形状。

二进制内容的具体含义由业务约定；存储、去重、权限、缓存与生命周期管理由宿主实现。

## 器件实例的属性生命周期

器件消费本规范时，属性是创建期固定配置：实例获得独立、递归只读快照，运行期属性更新必须拒绝且不自动重建。模型不注册属性变化监听，也不区分运行期可变与结构性属性；运行中的输入使用话题、消息及模型状态。宿主须隔离可变别名并保护嵌套值——仅靠 TypeScript `readonly` 不足以保证运行期不可修改。

器件定位由[器件定义](./device-definition.md)维护，作者接口由器件 JavaScript API 维护。Widget 实例的属性语义（运行期更新、`onPropsChanged`）见 [Widget JavaScript API](./widget-js-api.md)，本文不改变该合同。
