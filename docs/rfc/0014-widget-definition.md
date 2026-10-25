# Widget 定义

- Start Date: 2026-10-12
- Reference Issues: [#1](https://github.com/x-botlab/mica-js/issues/1)
- Implementation PR: [#113](https://github.com/x-botlab/mica-js/pull/113)

在包格式中增加 `widgets` 索引，定义 Widget 描述及同目录同名 JavaScript 配对。属性与话题端口是 Widget 定义的核心字段。

## 包字段

向 `package.json` 增加可选的 `widgets` 对象，缺省视为空索引；对象键是稳定 Widget ID：

```json
{
  "name": "example-package",
  "version": "1.0.0",
  "widgets": {
    "indicator": {
      "displayName": "指示灯",
      "description": "亮度指示",
      "path": "widgets/indicator.json"
    }
  }
}
```

| 字段          | 类型   | 约束                                  |
| ------------- | ------ | ------------------------------------- |
| `path`        | string | 必填，包内相对路径，引用 `.json` 文件 |
| `displayName` | string | 可选，缺省时使用 Widget ID            |
| `description` | string | 可选，展示说明                        |

Widget ID 与展示名称由索引提供。Widget ID 采用 `[a-z0-9][a-z0-9-]*`（kebab-case），与包 ID、属性键、端口键一致。

## Widget 描述

描述是 JSON 对象，核心字段由本规范引入：

| 字段         | 类型   | 语义                                           |
| ------------ | ------ | ---------------------------------------------- |
| `properties` | object | 属性键到公共属性描述的映射，省略视为空对象     |
| `ports`      | object | 端口键到公共话题端口描述的映射，省略视为空对象 |

```json
{
  "properties": {
    "color": { "type": "color", "default": "#22AA55FF" }
  },
  "ports": {
    "brightness": { "direction": "input", "type": "number" }
  }
}
```

属性描述引用[属性定义](./0009-device-properties.md)，话题端口描述引用[话题端口](./0010-topic-ports.md)。缺省空对象分别表示空属性集合与空端口集合。属性保存实例持久配置；运行状态由实例维护；绑定保存逻辑端口到目标端点的映射。

属性键与端口键使用稳定标识，字符规则为 `[a-z0-9][a-z0-9-]*`。

## 注册与实现定位

- `widgets` 显式列出注册条目；`path` 遵循包路径规则并引用 `.json` 文件。
- 将 `path` 的后缀替换为 `.js`，定位同目录同名实现。
- 静态校验读取描述并检查配对文件；描述错误或文件缺失返回明确诊断，整包失败或部分注册遵循包格式的统一策略。
- Widget 身份由包标识与 Widget ID 确定；展示名用于显示，路径用于定位，目录调整时同步更新索引路径。
- 内置 widget 使用保留命名空间 `builtin:<WidgetID>`，由宿主加载器识别，不在业务包索引中注册。
