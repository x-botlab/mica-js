# @mica-js/widget

Mica Widget 的纯数据契约：Widget 定义、端口/属性描述，以及把包内脚本解析为 `WidgetModule` 的加载器。

本包只负责**把 Widget 变成纯数据**，不执行脚本、不创建画布、不访问网络。运行时与编辑器只认识 `WidgetProvider`；「包」只是分发方式，解析逻辑收敛在 provider 实现里，不向上层泄漏。

## 安装

```bash
pnpm add @mica-js/widget
```

## 公共入口

唯一公开入口为 `@mica-js/widget`，构建生成 `dist/index.js`（ESM）与声明文件。

| 导出                                     | 作用                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `WidgetModule`                           | `{ definition, code }`：定义与单文件自包含 ESM 源码                  |
| `WidgetDefinition`                       | `properties`、`ports` 及可选的 `displayName` / `description`         |
| `PropertyDefinition`                     | 属性描述（#7），除 `type` 外字段原样透传                             |
| `PortDefinition`                         | 话题端口描述（#10）：`direction`、`type`，可选 `title`/`description` |
| `WidgetProvider`                         | 唯一方法 `resolve(ref): Promise<WidgetModule \| undefined>`          |
| `createStaticWidgetProvider(modules)`    | 固定模块表，用于内置 Widget 与测试                                   |
| `createPackageWidgetProvider({ files })` | 读取包并建立 `<包ID>:<widgetID>` 索引                                |
| `loadWidgetPackage(files)`               | 把单个包的字节来源解析为 `WidgetPackage`                             |
| `PackageFiles` / `WidgetPackage`         | 字节读取抽象与包解析结果                                             |
| `WidgetLoadError`                        | 带 `code`、`packageId`、`path` 的加载错误                            |

`PayloadType` 由 `@mica-js/core/canvas` 提供，本包不重复定义。

## 快速上手

```ts
import { createPackageWidgetProvider } from '@mica-js/widget';

const provider = await createPackageWidgetProvider({
  files: {
    label: 'gauge-package',
    async read(path) {
      return readFromDisk(`node_modules/gauge-package/${path}`);
    },
  },
});

const widget = await provider.resolve('gauge-package:brightness');
if (widget === undefined) {
  // 未知引用：调用方决定回退策略，这里不抛错。
} else {
  // widget.definition 是纯数据；widget.code 交给沙箱执行。
}
```

包只在构造 provider 时读取；之后每次 `resolve` 都命中内存索引，不再访问文件系统。坏包在构造阶段抛 `WidgetLoadError`，未知引用返回 `undefined`。

## 类型

```ts
interface WidgetModule {
  readonly definition: WidgetDefinition;
  readonly code: string;
}

interface WidgetDefinition {
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
  readonly ports: Readonly<Record<string, PortDefinition>>;
  readonly displayName?: string;
  readonly description?: string;
}

interface PropertyDefinition {
  readonly type: string;
  readonly default?: unknown;
  readonly [key: string]: unknown;
}

interface PortDefinition {
  readonly title?: string;
  readonly description?: string;
  readonly direction: 'input' | 'output';
  readonly type: PayloadType;
}

interface WidgetProvider {
  resolve(ref: string): Promise<WidgetModule | undefined>;
}
```

属性描述沿用 #7，本包只保留结构、不解析字段语义；`ports[*].type` 必须是 `@mica-js/core/canvas` 中 `PAYLOAD_TYPES` 的成员。

## 包格式

`loadWidgetPackage` 只读取三类路径，从不遍历目录：

1. `package.json`；
2. 清单 `widgets[*].path` 声明的 Widget 描述 `.json`；
3. 与描述同目录同名的 `.js` 实现。

```json
{
  "name": "gauge-package",
  "version": "1.0.0",
  "widgets": {
    "brightness": {
      "path": "widgets/brightness.json",
      "displayName": "亮度指示",
      "description": "亮度条指示"
    }
  }
}
```

- `name` 必填且为 kebab-case（`[a-z0-9][a-z0-9-]*`），同时也是包 ID；`version` 必填且非空。
- `widgets` 可省略，省略视为空索引；键是稳定 Widget ID，同样使用 kebab-case。
- 条目必须有 `path`，可选 `displayName` / `description`；后者写入 `WidgetDefinition`。
- 路径必须是包内相对 POSIX 路径：绝对路径、盘符、反斜杠与 `..` 片段一律报 `widget/invalid-manifest`。
- 实现路径由描述路径把 `.json` 换成 `.js` 得到；缺少实现报 `widget/no-implementation`。
- 实现必须是单文件自包含 ESM：`import`、动态 `import()`、`export ... from` 一律报 `widget/not-self-contained`；`export default` 不受限制。注释与字符串中的同名文本不算。
- 实现必须默认导出 Widget 工厂（#2）；缺少 `export default` 报 `widget/load-failed`。
- `contentHash` 是「按 Widget ID 排序后拼接全部源码」的 SHA-256 十六进制，用于判断包内容是否变化。

## 错误

`WidgetLoadError` 的 `code` 是稳定契约，`packageId` 与 `path` 指向出错的包和包内路径：

| `code`                      | 场景                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `widget/package-not-found`  | `package.json` 缺失或不可读                                 |
| `widget/invalid-manifest`   | 清单或 `widgets` 索引非法、路径越界、描述文件缺失           |
| `widget/invalid-definition` | 描述不是对象/非法 JSON，或 `ports` 类型不合法               |
| `widget/no-implementation`  | 同名 `.js` 实现缺失或不可读                                 |
| `widget/not-self-contained` | 实现包含 `import` 或 `export ... from`                      |
| `widget/load-failed`        | 实现没有默认导出，或环境缺少 `crypto.subtle` 等其它加载失败 |

## 边界

- 本包不执行源码、不创建 Worker、不校验脚本行为；执行与隔离属于沙箱。
- 不解析属性字段语义、不建立端口连接、不持久化实例配置。
- 不枚举包目录，不跟随重定向或符号链接；读取哪些文件完全由清单决定。
