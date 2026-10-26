# 宿主文件系统

- Start Date: 2026-10-26
- Reference Issues: —（设计讨论，无对应 issue）
- Implementation PR: —（尚未实现）

定义宿主侧的资源寻址与读取：`HostFs` 接口、URI 的表示、引用解析规则与错误分类。本文只约定接口与行为，不规定任何 scheme 的实现方式。

## 声明

### URI

资源以 URI 表示，类型为 `URI`（`vscode-uri`）。scheme、authority、path、query、fragment 是独立字段，非标准 scheme 不受 URL 归一化规则影响。

### 读取接口

```ts
interface HostFs {
  read(uri: URI): Promise<Uint8Array>;
}
```

`read` 接收绝对 URI，返回该资源的完整字节。

### 错误

```ts
interface HostFsError extends Error {
  readonly code: 'not-found' | 'out-of-root' | 'too-large' | 'undecodable';
  readonly uri: URI;
}
```

错误码不带命名空间前缀，跨线程传输时按码重建。

## 运行时

### 读取规则

- **只接受绝对 URI**：相对引用的解析由调用方完成，`read` 不接收相对形式，也不知道任何基准位置。
- **只返回字节**：文本解码、结构化解析与 base64 处理由调用方完成。
- **没有可选参数**：读取上限由实现按自身策略执行；调用方在取得字节后按资源声明的上限校验大小与像素。
- **失败必须抛错**：以 `HostFsError` 拒绝，`code` 取自下方分类。

### 引用解析

文档中的引用是字符串，解析结果必须是绝对 URI。按引用形态分三种：

| 引用形态             | 解析结果                                            |
| -------------------- | --------------------------------------------------- |
| 带 scheme 的绝对 URI | 原样使用                                            |
| 以 `/` 开头          | 换用基准 URI 的 scheme 与 authority，替换路径       |
| 其余（相对引用）     | 以基准 URI 的所在目录为基准合并，并规范化 `.`、`..` |

结果始终保留基准 URI 的 scheme 与 authority，因此相对引用不会跨出基准所在的寻址空间。

基准 URI 只有 authority 而没有路径时，相对引用会落在该 authority 之下，宿主应要求基准路径非空。

### `data:`

`data:` URI 自包含，没有 I/O 语义，由宿主本地解码，不经过 `read`。它仍受与其他资源相同的大小与像素上限约束。

### scheme

除 `data:` 外，规范不设内置 scheme 清单：支持哪些 scheme、如何映射到存储、如何授权、如何拒绝，全部由宿主决定。

### 不提供的操作

- 不提供目录枚举：包根与文档根由调用方显式给出。
- 不提供写入：`HostFs` 只读。
- 不规定缓存策略与并发顺序：实现可自行决定，多个 `read` 之间没有顺序保证。

## 校验

| 情形                 | `code`        |
| -------------------- | ------------- |
| 资源不存在           | `not-found`   |
| scheme 未实现或越权  | `out-of-root` |
| 超过实现的上限       | `too-large`   |
| `data:` 内容无法解码 | `undecodable` |

- 传入相对 URI 属于调用方错误，实现不得静默补全基准。
- 未识别的 scheme 按 `out-of-root` 报告，不新增错误码。

## 关联

- [RFC 0009](./0009-device-properties.md)：属性中的资源引用与建议的上限字段。
- [RFC 0018](./0018-canvas-runtime.md)：`WidgetHost` 与 `DeviceSimHost` 通过本接口读取画布文档、原理图与属性资源。
