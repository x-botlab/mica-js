# 程序属性与装载配置

- Start Date: 2026-11-16
- Reference Issues: [x-botlab/xbotlab#1113](https://github.com/x-botlab/xbotlab/issues/1113)
- Implementation PR: —（本地实现，待提交）

规定统一器件的 `program` 属性、程序来源、构建产物、内存与文件集装载结果，以及编辑器的选择交互。MUST / MUST NOT 表示强制要求，SHOULD 为推荐，MAY 为可选。

修订（2026-11-17）：统一 `program` 的内存与文件集装载；按宿主接入需求将来源收敛为资产、项目与包资源，选择交给宿主 UI；既有 `firmware` 保留资产与包资源装载，关联实现见文首 PR 字段。

## 声明

### 属性描述

`program` 复用 [RFC 0009](./0009-device-properties.md) 的 `title`、`description`、`default`、`nullable` 和 [RFC 0020](./0020-unified-device-package.md) 的 `group` / `order`；下表字段位于属性对象内。

| 字段                    | 类型     | 必填 | 约束                                                                |
| ----------------------- | -------- | ---- | ------------------------------------------------------------------- |
| `type`                  | string   | 是   | 固定 `program`                                                      |
| `loader`                | enum     | 是   | `memory` / `filesystem`，决定模型取得的值类型                       |
| `templates`             | string[] | 否   | 每项为非空、区分大小写、不重复的宿主模板 ID；省略或空数组表示无推荐 |
| `formats`               | string[] | 条件 | `memory` 必填，非空且不重复的 `bin` / `hex` / `elf` 子集            |
| `addressSpaces`         | object   | 条件 | `memory` 必填，非空的空间 ID 到空间描述的映射                       |
| `addressSpaces.*.title` | string   | 否   | 非空展示名称；省略时使用空间 ID                                     |
| `addressSpaces.*.start` | integer  | 条件 | 每个空间必填，允许装载范围的非负起始字节地址                        |
| `addressSpaces.*.size`  | integer  | 条件 | 每个空间必填，允许装载范围的正安全整数字节数                        |
| `defaults`              | object   | 条件 | 接受 BIN 或 HEX 时必填；仅接受 ELF 时省略                           |
| `defaults.addressSpace` | string   | 条件 | `defaults` 存在时必填，引用已声明空间，供 BIN / HEX 使用            |
| `defaults.loadAddress`  | integer  | 条件 | 接受 BIN 时必填，位于默认空间内的非负安全整数；其余省略             |

- `filesystem` 只声明通用字段、`loader` 与可选 `templates`；启动文件、执行顺序、语言和 API 版本由器件运行时定义。
- 默认值使用包内引用或在可空时使用 `null`；`nullable` 缺省 `false`，缺值按默认值补全，必需值缺失拒绝准备。
- `program` 使用框架统一的固定资源限制，属性不声明 `maxFiles`、`maxFileBytes`、`maxTotalBytes`、`maxBytes` 或路径额度。
- 模板 ID 是宿主稳定身份，随器件版本发布；选择项目时按声明顺序透传为 `templateIds`，宿主决定推荐项的展示与可用性。
- `memory` 的空间 ID 为非空且区分大小写的稳定字符串，仅在当前属性内有效；模型按属性名与空间 ID 映射实际存储器。
- 空间范围为 `[start, start + size)`，`start + size` MUST 为安全整数；装载地址是绝对字节地址，不相对 `start` 再偏移。
- 不同空间允许使用相同数值地址；每个段的完整范围必须落在所属空间内，声明空间 MUST 与模型映射一致。

### 来源与实例覆盖

持久类型 `ProgramReference` 见 [RFC 0024](./0024-fused-schematic-format.md)，属性的 `loader` 决定引用的解释。

| 引用字段       | 类型    | 必填 | 约束                                                       |
| -------------- | ------- | ---- | ---------------------------------------------------------- |
| `mode`         | enum    | 是   | `asset` / `package` / `project`                            |
| `src`          | string  | 条件 | `package` 必填；`memory` 指文件，`filesystem` 指程序根目录 |
| `assetId`      | string  | 条件 | `asset` 必填，非空资产身份                                 |
| `name`         | string  | 条件 | `asset` 必填且包含格式扩展名，`project` 可选展示名称       |
| `projectId`    | string  | 条件 | `project` 必填，宿主非空、区分大小写的稳定项目 ID          |
| `addressSpace` | string  | 否   | 仅 BIN / HEX，覆盖默认空间且必须引用已声明空间             |
| `loadAddress`  | integer | 否   | 仅 BIN，覆盖默认基址，非负安全整数且位于所选空间内         |

- `package` 的 `src` 相对当前锁定包根；目录使用无末尾 `/` 的非空路径，资产由宿主按 `assetId` 读取二进制。
- `filesystem` 目录递归收集普通文件，产物路径相对此目录；包内目录从发布文件清单按精确目录前缀列举，每个文件继续验证大小与摘要。
- 包内目录以存在 `<src>/` 前缀的文件记录为依据，无记录按 `package/not-found` 拒绝，前缀匹配保留目录边界。
- 文件集资产使用 ZIP；解包前按中央目录校验路径、重复项和未压缩额度，解包后按文件集规则再次验证，错误拒绝整个资产。
- 项目引用保存稳定 ID 与可选展示名称；临时路径、产物内容及打开状态属于宿主与会话数据，项目来源仅用于 `program`。
- BIN / HEX 空间覆盖省略时使用 `defaults.addressSpace`，BIN 基址独立省略时使用 `defaults.loadAddress`，不得按新空间起点自动修正。
- BIN 的第 `i` 个字节装载到 `loadAddress + i`；HEX 保留记录绝对地址；HEX 拒绝基址覆盖，ELF 和文件集拒绝空间与基址覆盖。

### 构建产物

```ts
interface ProgramFile {
  readonly path: string;
  readonly data: Uint8Array;
}
type ProgramArtifact =
  | {
      readonly kind: 'memory';
      readonly format: 'bin' | 'hex' | 'elf';
      readonly data: Uint8Array;
    }
  | {
      readonly kind: 'filesystem';
      readonly files: readonly ProgramFile[];
    };
```

- 项目来源返回原始产物，`kind` 必须等于属性 `loader`；内存产物的 `format` 必须属于属性 `formats`，内容与格式不符明确拒绝。
- 框架在运行准备时捕获产物及其字节的独立快照；资产 ZIP 由框架解包，项目直接返回文件集，模型消费相同的规范化结果。

### 模型输入

```ts
interface ProgramSegment {
  readonly addressSpace: string;
  readonly address: number;
  readonly data: ReadonlyBytes;
}
interface MemoryProgram {
  readonly segments: readonly ProgramSegment[];
}
interface ProgramFiles {
  readonly paths: readonly string[];
  read(path: string): ReadonlyBytes;
}
```

- `memory` 经解码交付 `MemoryProgram`，`filesystem` 交付 `ProgramFiles`；生成类型按属性的 `loader` 确定，可空属性另加 `null`。
- `ReadonlyBytes` 复用现行[核心只读字节快照合同](../spec/javascript/interfaces.rst)；数组、描述与字节均只读，`slice()` 返回独立可写副本。
- 内存段及每段字节非空，地址为非负安全整数；同空间段范围 MUST NOT 重叠，段按空间 ID 的 UTF-16 代码单元顺序、地址升序排列，空洞保持未写入。
- 文件路径是区分大小写的相对 POSIX 路径；拒绝空路径、空段、`.`、`..`、反斜杠、绝对路径、盘符、NUL、重复路径和文件与目录前缀冲突。
- 文件集只包含普通文件，零字节文件和空文件集合法；目录由路径隐含表达，`paths` 按 UTF-16 代码单元顺序排列。
- `read` 按精确路径同步读取快照，缺失按 `program/file-not-found` 抛错，非法路径按 `program/invalid-path` 抛错；必需文件及启动失败由器件运行时诊断。
- JavaScript 模型工厂从 `ctx.props.<属性名>` 取得准备结果；模型 IR MUST NOT 声明同名 DDL 属性，普通属性继续按类型校验后传给 IR。
- 内存模型在首次推进前按空间映射装载，复位向量和启动位置由模型控制；脚本模型读取文件集并按自身规则执行。
- 输入文件集保持只读；程序运行中产生的可写数据由器件运行时管理，与输入快照分离。

### 内存格式转换

- 固定文件按可靠文件名最后一个扩展名忽略 ASCII 大小写识别：`.bin`、`.hex` / `.ihx`、`.elf` / `.axf`；未知格式拒绝，不猜测内容格式。
- 项目以返回的 `format` 为准；BIN 使用选定空间与基址生成一个段，完整字节长度参与范围校验。
- HEX 校验记录长度、校验和、类型、地址及结束记录；扩展段和扩展线性地址参与绝对地址计算，入口记录仅校验，所有数据进入所选空间。
- ELF 接受已链接 `ET_EXEC`，支持 ELF32 / ELF64 及两种字节序；结构、段表、文件内范围和地址整数均须合法，拒绝动态链接或装载时重定位。
- ELF 的每个 `PT_LOAD` 只装载 `p_filesz` 字节，以 `p_paddr` 为绝对地址，要求 `p_filesz <= p_memsz`；零文件长度段跳过，其余内存初始化及入口由模型处理。
- 每个 ELF 装载段须恰好落入一个声明空间；无匹配报越界，多匹配报空间歧义，不按默认空间消歧或拆段跨空间。
- 解码后统一检查非空镜像、完整范围和同空间重叠；相邻段 MAY 合并，失败不交付部分镜像。

### 固定资源限制

- 框架对全部来源执行同一组固定的产物输入字节、文件数量、单文件字节、总文件字节、路径长度与深度限制；包来源同时遵守包资源额度。
- 额度按单个程序属性的捕获结果计算；文件数包含零字节文件，总字节为全部文件长度之和，路径长度按 UTF-8 字节计，深度按路径段数计。
- 限制按未压缩字节计算，内存格式的原始字节和解码结果均受限；遍历和捕获过程中超限立即终止，按 `program/resource-limit` 拒绝准备。
- 固定上限由 SDK 的 `PROGRAM_LIMITS` 公开：文件集每属性最多 `1024` 个文件，单文件 `32 MiB`，文件总量 `64 MiB`；内存输入与解码结果各 `64 MiB`；路径 `1024` 个 UTF-8 字节、深度 `32`；`1 MiB = 1048576` 字节。
- 器件清单与项目 Provider 使用统一额度；旧 `firmware` 属性保留既有装载行为，新声明使用 `program`。

## 运行时

### 准备与快照

- 框架解析全部程序引用，校验装载类型、格式、文件路径、资源限制及内存范围后，才执行任何模型工厂；失败保留引用并报告准备错误。
- 工厂与展示取得内容相同的独立只读快照；同步文件读取在隔离执行环境内完成，不在模型执行期间请求宿主 I/O。
- 当前运行及 `reset` 复用已捕获内容，项目重建和文件变更不替换当前程序；重新解析遵循 [RFC 0024](./0024-fused-schematic-format.md) 的新运行准备边界。

### 选择与项目

- 字段以单行显示来源图标、当前名称和默认标记；来源图标按钮打开浮层菜单，提供资产库、项目和内置资源入口，资产与项目通过宿主 UI 返回单个引用，接口见 [RFC 0025](./0025-fused-runtime.md) 与 [RFC 0028](./0028-workbench-host-resources.md)。
- `memory` 按 `formats` 筛选；`filesystem` 选择 ZIP 资产、项目文件集或包内目录，包内候选目录从发布清单的 `assets/` 下推导。
- 选择通过 [RFC 0024](./0024-fused-schematic-format.md) 的属性事务提交；缺失项目、目录或解析失败保留引用并显示错误，允许重试。
- 项目值旁提供 Codicons `folder-open` 按钮“打开项目”，点击按当前项目 ID 触发宿主事件，保持文档历史与仿真状态；非项目值隐藏按钮。
- 选择项目时将属性的推荐模板 ID 传给宿主，宿主可返回已有或新建项目；取消或失败保留原属性，实例只保存最终项目引用。

### 装载详情

- `memory` 在字段同一行提供“装载设置”图标，点击打开浮层；展示格式、空间名称、范围和段地址，BIN 基址可编辑，BIN / HEX 空间可选择，ELF 结果只读。
- 只有一个空间时只读展示空间；多个空间时 BIN / HEX 允许选择；地址原点为零的模型内存可直接以段地址为偏移，其他模型按映射转换。
- 基址接受十进制或 `0x` 十六进制，校验后保存 JSON 数字；空间及基址的有效编辑作为一次属性事务，待解析显示加载状态，失败明确显示错误。
- 已存覆盖与新产物格式不适用时保留引用并报错；重新选择来源创建不含旧覆盖的新引用。
- `filesystem` 字段显示来源和名称；文件缺失及运行入口问题按器件规则报告。
- 运行与暂停期间可浏览内存装载设置和打开项目，来源及装载覆盖只读。
- 异步解析结果只应用于仍匹配的当前属性与会话；过期结果丢弃，读取失败保留当前引用和历史，就地输入校验失败不提交。

## 校验

| 诊断码                            | 条件与行为                                                           |
| --------------------------------- | -------------------------------------------------------------------- |
| `package/invalid-manifest`        | 装载方式、格式、空间、默认地址、模板或通用属性字段非法，拒绝装载     |
| `schema/invalid-value`            | 来源结构非法，或空间与基址覆盖不适用，拒绝编辑或运行准备             |
| `program/unknown-format`          | 固定文件扩展名未知，保留引用并拒绝准备                               |
| `program/unsupported-format`      | 已知内存格式未在当前属性接受列表中，拒绝准备                         |
| `program/invalid-format`          | 内容与声明格式不符或内存文件结构非法，拒绝准备                       |
| `program/loader-mismatch`         | 项目产物 `kind` 与属性 `loader` 不一致，拒绝准备                     |
| `program/ambiguous-address-space` | ELF 段匹配多个空间，拒绝准备                                         |
| `program/invalid-image`           | 空镜像、非法段、重叠或未知空间，拒绝准备                             |
| `program/out-of-range`            | 基址或完整段越界，拒绝编辑或准备                                     |
| `program/invalid-path`            | 文件集含非法、重复路径或文件与目录冲突，拒绝准备或读取               |
| `program/file-not-found`          | 快照内读取的文件不存在，向调用方抛错                                 |
| `program/resource-limit`          | 任一固定资源限制超限，拒绝准备                                       |
| `program/source-resolve-failed`   | 工程目录缺失、授权或读取失败、返回文件集结构非法，保留引用并拒绝准备 |
| `program/project-list-failed`     | 项目列表读取失败或结构非法，保留引用并显示错误                       |
| `program/project-resolve-failed`  | 项目缺失、产物读取失败或结构非法，保留引用并拒绝准备                 |

资源读取继续保留 HostFs 的失败分类与包摘要校验；错误不交付部分结果，不自动改选程序来源。

## 示例

- [全字段器件清单](./examples/0020-device-package.json) 的 `properties.program` 演示内存属性，`properties.scripts` 演示文件集属性；两者仅用于展示结构。
- [完整来源示例](./examples/0026-firmware-sources.json) 覆盖内存文件、地址覆盖、项目与目录来源；[完整文档](./examples/0024-fused-schematic.json) 保存项目引用。
- 示例 BIN 基址为 `256`，空间范围为 `0x0000–0x1FFF`，允许装载的 BIN 最大长度为 `7936` 字节。

```js
for (const segment of ctx.props.program?.segments ?? []) {
  if (segment.addressSpace !== 'code') throw new Error('Unsupported program address space');
  ctx.loadBytes('code', segment.data.slice(), segment.address);
}
```

OpenMV 类模型可从 `ctx.props.scripts.read('main.py')` 取得只读字节；是否执行 `boot.py`、`main.py`、其他文件及其先后顺序由该器件运行时规定。

## 范围

- 包资源、默认值和资源浏览由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 持久引用和属性事务由 [RFC 0024](./0024-fused-schematic-format.md) 规定。
- 宿主项目选择、模板 ID 透传、打开事件及运行生命周期由 [RFC 0025](./0025-fused-runtime.md) 规定。
- 模型工厂与同步执行边界由 [RFC 0021](./0021-device-model-api.md) 规定，属性类型投影由 [RFC 0027](./0027-device-type-generation.md) 规定。

## 关联

- [RFC 0009](./0009-device-properties.md)：既有属性基础；本文的程序属性属于融合合同，普通二进制属性继续按原合同解释。
