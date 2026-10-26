# 宿主文件系统

- Start Date: 2026-10-26
- Reference Issues: —（设计讨论，无对应 issue）
- Implementation PR: —（尚未实现）

定义宿主侧的资源寻址与读取：`HostFs` 接口、URI 的表示、引用解析规则与错误分类。scheme 的映射与授权由宿主决定。

## 声明

### URI

资源以 URI 表示，类型为 `URI`（`vscode-uri`）。scheme、authority、path、query、fragment 是独立字段；`vscode-uri` 提供 `parse`、`joinPath`、`dirname`、`resolvePath` 等工具，解析与路径合并可直接复用。

### 读取接口

```ts
interface HostFs {
  read(uri: URI): Promise<Uint8Array>;
}
```

`read` 的入参是绝对 URI，返回该资源的完整字节。

### 错误

```ts
interface HostFsError extends Error {
  readonly code: 'FileNotFound' | 'NoPermissions' | 'NoFileSystem' | 'Unavailable';
  readonly uri: URI;
}
```

`code` 给出失败分类，`uri` 指向出错的资源。错误跨线程传输时按 `code` 重建实例。

## 运行时

### 读取规则

- **绝对 URI**：`read` 的入参始终是绝对 URI，相对引用的解析由调用方完成。
- **原始字节**：`read` 返回字节，文本解码、结构化解析与 base64 处理由调用方完成。
- **策略上限**：读取上限由实现按自身策略执行，超出策略时以 `NoPermissions` 拒绝；调用方在取得字节后按资源声明的上限校验大小与像素。
- **错误**：失败以 `HostFsError` 拒绝，`code` 取自下方分类。

### 引用解析

文档中的引用是字符串，解析结果必须是绝对 URI。按引用形态分三种：

| 引用形态             | 解析结果                                            |
| -------------------- | --------------------------------------------------- |
| 带 scheme 的绝对 URI | 原样使用                                            |
| 以 `/` 开头          | 换用基准 URI 的 scheme 与 authority，替换路径       |
| 其余（相对引用）     | 以基准 URI 的所在目录为基准合并，并规范化 `.`、`..` |

结果始终保留基准 URI 的 scheme 与 authority，相对引用在基准所在的寻址空间内解析。

基准 URI 只有 authority 而路径为空时，相对引用落在该 authority 之下，宿主应要求基准路径非空。

### `data:`

`data:` URI 自包含，内容随引用一同给出，由宿主本地解码；`read` 的调用对象是有 I/O 语义的 scheme。它与其他资源受相同的大小与像素上限约束。

### scheme

`data:` 以外的 scheme 由宿主定义：支持哪些 scheme、如何映射到存储、如何授权，全部由宿主决定。

### 操作范围

- **读取**：`HostFs` 提供只读访问。
- **定位**：包根与文档根由调用方显式给出，宿主据此解析引用。
- **缓存与并发**：缓存策略由实现决定，多个 `read` 的完成顺序由实现安排。

## 校验

| `code`          | 触发条件                                         |
| --------------- | ------------------------------------------------ |
| `FileNotFound`  | URI 指向的资源在当前工作区中缺失                 |
| `NoPermissions` | 授权拒绝，或实现按自身策略拒绝（含超过实现上限） |
| `NoFileSystem`  | 请求的 scheme 落在宿主支持的 scheme 之外         |
| `Unavailable`   | 后端离线、正在重载或已被卸载，稍后重试可以成功   |

- 相对引用由调用方解析为绝对 URI 后再传入。
- `data:` 的解码结果由调用方按自身错误分类报告。
- 资源大小与像素上限由调用方按资源声明校验；实现策略更严格时以 `NoPermissions` 拒绝。

## 关联

- [RFC 0009](./0009-device-properties.md)：属性中的资源引用与建议的上限字段；本文的错误分类承担该文建议的 `asset/*` 错误码。
- [RFC 0018](./0018-canvas-runtime.md)：`WidgetHost` 与 `DeviceSimHost` 通过本接口读取画布文档、原理图与属性资源。
