# 器件定义

> **状态**：已确认（提案已关闭） · **来源**：[#11](https://github.com/x-botlab/mica-js/issues/11) · **同步**：2026-10-25
> **实现**：[`packages/device/src/description.ts`](../../packages/device/src/description.ts) · [`packages/device/src/loader.ts`](../../packages/device/src/loader.ts)
> **相关**：[包格式](./package-format.md) · [属性定义](./device-properties.md) · [话题端口](./topic-ports.md) · [引脚声明](./device-pins.md) · [IR 核心](./device-ir.md)

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

器件 ID 与展示名称由索引提供。器件身份由包标识与器件 ID 确定，具体实例引用编码由消费方定义；包名与器件 ID 的合法字符及版本解析分别遵循[包格式](./package-format.md)。

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
- 属性类型与默认值引用[属性定义](./device-properties.md)；端口方向、载荷与绑定状态语义引用[话题端口](./topic-ports.md)。
- 属性保存持久配置。器件实例创建时获得独立、递归只读快照，实例存续期间不可修改，运行期属性更新必须拒绝且不自动重建。运行中变化通过话题、消息或获准的 IR 状态表达，不引入属性变化监听或结构性属性登记。
- 当前帧、寄存器与仿真进度由实例运行状态维护；逻辑端口到目标端点的映射由绑定保存。
- `bytes` 及带标签的 `bytes<...>` 端口载荷是字节序列，其布局、编码与业务协议由通信双方约定，器件定义必须写明布局。

器件描述在上述核心字段之外由其他规范扩展，字段与校验归各自规范：`pins` / `pinGroups` 见[引脚声明](./device-pins.md)，`powerDomains` 及引脚的 `powerDomain` / `levels` 见[电源域](./device-power-domains.md)，`connections` 见[内部可控连接](./device-topology.md)。

## 实现配对

- `path` 遵循包路径规则并指向 `.json` 文件；将后缀替换为 `.js`，定位同目录同名的 JavaScript 模块。
- 模块默认导出同步工厂，工厂通过作者 API 构建 IR；不要求预编译 WASM，也不提供 WASM 实现的兼容分支或自动回退。
- 安装校验检查描述、实现文件与模块导出形式。实例化时调用同步工厂，工厂返回或抛出后封闭声明，随后进行 IR 校验与链接，通过后由内核执行初始化入口。
- 文件缺失、描述或模块错误、建图及链接失败必须明确报告；整包安装结果遵循[包格式](./package-format.md)的统一策略。

实现配对只确定文件定位关系。工厂、生命周期绑定、消息桥接与错误清理由[IR 核心](./device-ir.md)与器件作者 API 维护；执行语义与校验由 [IR 核心](./device-ir.md)维护。宿主可以缓存内部编译产物，但缓存不成为第二个实现定位来源。

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

| 对象               | 规则                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| `devices`          | 对象类型；缺省视为空索引                                                     |
| 索引条目           | `path` 为非空字符串；`displayName`、`description` 为字符串                   |
| 描述文件           | 单个 JSON 对象                                                               |
| `properties`       | 按[属性定义](./device-properties.md)校验；无法使用的描述被忽略，不写入非法值 |
| `ports`            | 按[话题端口](./topic-ports.md)校验方向、载荷类型与未知字段                   |
| `designatorPrefix` | 字符串；去除首尾空白，空字符串视为未声明；省略时按 `U`                       |
| 顶层未知字段       | 忽略，不参与描述解析                                                         |
| 实现配对           | `.js` 必须存在且默认导出同步工厂；缺失或导出形式不符时报错                   |
