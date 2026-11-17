# 工作台文档与宿主资产

- Start Date: 2026-11-17
- Reference Issues: —（尚未实现）
- Implementation PR: [#285](https://github.com/x-botlab/mica-js/pull/285)

规定融合工作台的数据接入、保存回调和宿主资产选择。为收窄宿主接入，文档直接传入，资源由稳定身份解析。MUST 表示强制要求，SHOULD 表示推荐要求。

## 声明

创建工作台时提供下列宿主字段；其余编辑器能力见 [RFC 0025](./0025-fused-runtime.md)。

| 字段            | 类型           | 必填 | 约束                                                                 |
| --------------- | -------------- | ---- | -------------------------------------------------------------------- |
| `document`      | FusedDocument  | 是   | 初始文档数据，框架校验并捕获独立只读快照                             |
| `saveDocument`  | function       | 否   | `(document: FusedDocument) => Promise<void>`，完成表示保存此快照成功 |
| `assetProvider` | IAssetProvider | 否   | 已保存资产引用读取和用户主动选择的宿主能力                           |

```ts
interface IAssetInfo {
  readonly id: string;
  readonly name: string;
}
interface IAssetRequest {
  readonly kind: 'image' | 'binary' | 'program';
  readonly formats?: readonly string[];
  readonly signal: AbortSignal;
}
interface IAssetProvider {
  select(request: IAssetRequest): Promise<IAssetInfo | undefined>;
  read(assetId: string, signal: AbortSignal): Promise<Uint8Array>;
}
```

- `id` 是宿主提供的非空资产身份，通常为 UUID；`name` 为非空文件名，包含程序格式扩展名。
- `kind` 与 `formats` 表示选择条件；内存程序使用声明格式，文件集资产使用 `zip`，二进制使用属性扩展名。
- 资产 UUID SHOULD 对应不可变内容；名称作为显示及格式元信息，读取始终使用 `id`。
- 资产库的枚举、搜索和上传属于宿主选择界面，编辑器 MUST NOT 请求枚举资产。
- 资源属性仅接受资产或包资源，只有 `program` 可以引用项目；项目选择接口见 [RFC 0025](./0025-fused-runtime.md)。

## 运行时

- 宿主负责文档身份、存储位置、读取和序列化；工作台通过内容事件发布已提交的文档快照。
- `save()` 调用可选的 `saveDocument`；缺失时拒绝为 `save/unavailable`，回调拒绝为 `save/failed`，失败保持未保存标记。
- 保存与编辑按文档事务顺序处理；保存成功仅标记传给回调的版本，后续修改继续显示未保存。
- 点击“从资产库选择”调用 `select`，宿主打开选择 UI；取消返回 `undefined`，保留原值与历史。
- 选择返回后框架按 ID 读取并校验内容，成功后以一次可撤销事务提交引用；读取失败保留原引用并显示错误。
- 已保存引用在重新打开或新运行准备时直接调用 `read`；当前运行和复位使用捕获快照。
- 目标属性改变、退出编辑或关闭工作台时取消在途选择；过期返回不得覆盖新值。
- 字段在单行显示来源图标、名称与默认标记，同行图标打开来源菜单或详情浮层；菜单调用宿主选择器或包资源选择器，可空字段允许清除，有默认值的覆盖项允许恢复默认；浮层支持外部点击与 Esc 关闭。
- 只读状态保留详情浏览与打开项目能力，来源和装载设置保持只读。

## 校验

- 非法来源、空身份、空名称和未知字段按文档校验拒绝；已移除的来源需由宿主迁移为资产或包资源引用。
- 选择元信息及二进制内容均须校验；候选筛选不能代替运行准备的格式、额度、地址和文件集检查。
- 图片校验解码结果与像素额度；程序按装载方式校验，失败不提交部分引用或部分文件。

## 示例

合法来源的完整结构见 [资源与程序引用示例](./examples/0026-firmware-sources.json) 和 [融合文档示例](./examples/0024-fused-schematic.json)。

## 范围

- 依赖锁定与持久属性结构由 [RFC 0024](./0024-fused-schematic-format.md) 规定。
- 包资源与选择过滤由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 项目选择、推荐模板 ID 透传及运行快照由 [RFC 0025](./0025-fused-runtime.md) 规定。
- 程序格式、文件集与装载额度由 [RFC 0026](./0026-firmware-properties.md) 规定。
