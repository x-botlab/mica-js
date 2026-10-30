# 器件定义

- Start Date: 2026-10-15
- Reference Issues: [#11](https://github.com/x-botlab/mica-js/issues/11)
- Implementation PR: [#104](https://github.com/x-botlab/mica-js/pull/104)

在包格式中增加 `devices` 索引，定义器件描述、核心属性与话题端口，以及构建 IR 的 JavaScript 工厂定位方式。器件定义独立于包格式，也独立于具体引脚协议与运行时优化。

## 包字段

向 `package.json` 增加可选的 `devices` 对象，缺省视为空索引；对象键是稳定器件 ID：

```json
{
  "name": "example-package",
  "version": "1.0.0",
  "devices": {
    "display": {
      "displayName": "显示屏",
      "description": "示例显示器件",
      "path": "devices/display.json"
    }
  }
}
```

| 字段          | 类型   | 约束                                  |
| ------------- | ------ | ------------------------------------- |
| `path`        | string | 必填，包内相对路径，引用 `.json` 文件 |
| `displayName` | string | 可选，缺省时使用器件 ID               |
| `description` | string | 可选，展示说明                        |

器件 ID 与展示名称由索引提供。器件身份由包标识与器件 ID 确定，具体实例引用编码由消费方定义；包名与器件 ID 的合法字符及版本解析分别遵循[包格式](./0011-package-format.md)。

## 器件描述

器件描述的核心字段：

| 字段               | 类型   | 语义                                                                                                            |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| `properties`       | object | 属性键到公共属性描述的映射，省略视为空对象；`image` / `binary` 属性的实例值使用资源引用对象 `{ "src", "mode" }` |
| `ports`            | object | 逻辑端口键到公共话题端口描述的映射，省略视为空对象                                                              |
| `designatorPrefix` | string | 可选，原理图位号前缀（`U`、`R`、`DS` 等）；省略时编辑器按 `U` 处理                                              |

```json
{
  "properties": {
    "label": { "type": "string", "default": "Display" }
  },
  "ports": {
    "frame": { "title": "帧数据", "direction": "output", "type": "bytes<rgb565>" }
  }
}
```

- `designatorPrefix` 只影响原理图侧的位号生成：编辑器放置该器件时取「前缀 + 最小未占用编号」（如 `R1`、`R2`），不参与电气语义。取值去除首尾空白，空字符串视为未声明。
- 属性类型与默认值引用[属性定义](./0009-device-properties.md)；端口方向、载荷与绑定状态语义引用[话题端口](./0010-topic-ports.md)。
- 属性保存持久配置。器件实例创建时获得独立、递归只读快照，实例存续期间不可修改，运行期属性更新必须拒绝且不自动重建。运行中变化通过话题、消息或获准的 IR 状态表达，不引入属性变化监听或结构性属性登记。
- 当前帧、寄存器与仿真进度由实例运行状态维护；逻辑端口到目标端点的映射由绑定保存。
- `bytes` 及带标签的 `bytes<...>` 端口载荷是字节序列，其布局、编码与业务协议由通信双方约定，器件定义必须写明布局。

器件描述在上述核心字段之外由其他规范扩展，字段与校验归各自规范：`pins` / `pinGroups` 见[引脚声明](./0006-device-pins.md)，`powerDomains` 及引脚的 `powerDomain` / `levels` 见[电源域](./0007-device-power-domains.md)，`connections` / `resistors` 见[内部可控连接与电阻支路](./0008-device-topology.md)。

## 实现配对

- `path` 遵循包路径规则并指向 `.json` 文件；将后缀替换为 `.js`，定位同目录同名的 JavaScript 模块。
- 模块默认导出同步工厂，工厂通过作者 API 初始化电气资源并返回行为钩子；复杂器件可以继续通过 `kernel` 构建 IR，并与同一实例的电气资源绑定。
- 不要求预编译 WASM，也不提供 WASM 实现的兼容分支或自动回退。
- 安装校验检查描述、实现文件与模块导出形式。实例化时调用同步工厂，工厂返回或抛出后封闭声明，随后进行 IR 校验与链接，通过后由内核执行初始化入口。
- 文件缺失、描述或模块错误、建图及链接失败必须明确报告；整包安装结果遵循[包格式](./0011-package-format.md)的统一策略。

实现配对只确定文件定位关系。工厂、生命周期绑定、消息桥接与错误清理由[IR 核心](./0003-device-ir.md)与器件作者 API 维护；执行语义与校验由 [IR 核心](./0003-device-ir.md)维护。宿主可以缓存内部编译产物，但缓存不成为第二个实现定位来源。

### 电气资源初始化

线性电阻器件的电气资源由 JSON 声明与 JS 工厂共同构成。

- JSON 声明引脚、支路端点、触点和属性；JS 工厂提供初始数值，形成完整的电气资源描述。
- 每个实例的工厂取得独立的递归只读属性快照；已声明实例值覆盖合法属性默认值，取值按 [RFC 0009](./0009-device-properties.md) 校验。
- 普通电阻同样具有配对 JS 工厂；只有电气资源初始化、没有 tick 或 update 入口的工厂是合法实现。
- 工厂上下文的 `electrical.initializePin` 由 [RFC 0006](./0006-device-pins.md) 定义，`electrical.initializeResistor` 由 [RFC 0008](./0008-device-topology.md) 定义。
- 工厂返回或抛出后封闭初始化入口；保留上下文的后续调用报告 `electrical/factory-closed`。
- 同一资源重复初始化报告 `electrical/duplicate-initialization`，未知资源报告 `electrical/unknown-resource`。
- 工厂返回 Promise 或其他 thenable 时拒绝装载；运行期变化由已生成的 IR 表达，属性快照不随之修改。
- 初始化只接收 JS 标量和声明对象；运行期 IR 指令接收 SSA 值，两者具有不同的执行阶段。

工厂上下文的电气部分：

```ts
interface ElectricalFactoryContext {
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly electrical: DeviceElectricalInitialization;
}
```

`PropertyValue` 由 [RFC 0009](./0009-device-properties.md) 定义；`DeviceElectricalInitialization` 汇集上述两个资源合同的初始化方法。普通 IR 建图能力继续遵守 [RFC 0003](./0003-device-ir.md)，不因本节增加运行期 JS 回调。

例如包索引定位 `devices/resistor.json`，同目录 `resistor.js` 为配对实现。器件名称、描述及身份由包索引提供；JSON 不重复声明它们。

```json
{
  "designatorPrefix": "R",
  "properties": {
    "resistance": { "type": "number", "default": 1000, "exclusiveMin": 0, "unit": "ohm" }
  },
  "pins": {
    "A": { "kind": "signal", "side": "left" },
    "B": { "kind": "signal", "side": "right" }
  },
  "resistors": {
    "body": { "pins": ["A", "B"] }
  }
}
```

```js
export default function createResistor(ctx) {
  ctx.electrical.initializeResistor('body', {
    resistance: ctx.properties.resistance,
    enabled: true,
  });
}
```

实例属性是初始阻值的唯一来源；`resistors.body` 不重复保存 `resistance`，也不引入属性引用表达式。工厂结束后缺少任一已声明电阻的初始化时报告 `electrical/missing-initialization`。

## 关联文件命名规范

给定器件描述的 `path`（如 `devices/display.json`），通过替换后缀定位相关文件：

| 后缀     | 职责                                                  | 必需性 |
| -------- | ----------------------------------------------------- | ------ |
| `.json`  | 器件描述（`properties`、`ports`、`designatorPrefix`） | 必需   |
| `.js`    | IR 工厂实现，默认导出同步工厂函数                     | 必需   |
| `.d.ts`  | TypeScript 类型定义，导出访问器接口                   | 可选   |
| `.ac.js` | 访问器构建器，默认导出构建函数                        | 可选   |

所有文件位于同一目录，文件名（不含后缀）相同。`.d.ts` 与 `.ac.js` 的接口形式单独定义，不改变本规范的文件定位关系。

## 与其他包内容的关系

`devices` 具有独立的器件 ID 作用域。各内容索引分别管理自己的 ID，实例引用通过内容种类与 ID 识别对象，具体编码由消费合同确定。

## 校验

| 对象               | 规则                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `devices`          | 对象类型；缺省视为空索引                                                          |
| 索引条目           | `path` 为非空字符串；`displayName`、`description` 为字符串                        |
| 描述文件           | 单个 JSON 对象                                                                    |
| `properties`       | 按[属性定义](./0009-device-properties.md)校验；无法使用的描述被忽略，不写入非法值 |
| `ports`            | 按[话题端口](./0010-topic-ports.md)校验方向、载荷类型与未知字段                   |
| `designatorPrefix` | 字符串；去除首尾空白，空字符串视为未声明；省略时按 `U`                            |
| 顶层未知字段       | 忽略，不参与描述解析                                                              |
| 实现配对           | `.js` 必须存在且默认导出同步工厂；缺失或导出形式不符时报错                        |
