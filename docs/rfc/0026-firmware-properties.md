# 固件属性与装载配置

- Start Date: 2026-11-16
- Reference Issues: —（尚未实现）
- Implementation PR: —（尚未实现）

规定统一器件的 `firmware` 属性、属性内地址空间、文件与宿主项目引用、项目产物、格式转换、运行时镜像，以及编辑器的选择和装载配置交互。本合同为待实现草案。MUST / MUST NOT 表示强制要求，SHOULD 为推荐，MAY 为可选。

## 声明

### 属性与地址空间

`firmware` 复用 [RFC 0009](./0009-device-properties.md) 的通用属性描述字段与 `maxBytes`，并复用 [RFC 0020](./0020-unified-device-package.md) 的 `group` / `order`；额外字段均定义在对应属性对象内。

| 字段                    | 类型    | 必填 | 约束                                                |
| ----------------------- | ------- | ---- | --------------------------------------------------- |
| `addressSpaces`         | object  | 是   | 非空的空间 ID 到地址空间描述的映射                  |
| `addressSpaces.*.title` | string  | 否   | 非空展示名称；省略时使用空间 ID                     |
| `addressSpaces.*.start` | integer | 是   | 空间允许装载范围的起始地址                          |
| `addressSpaces.*.size`  | integer | 是   | 允许装载范围的字节数，正安全整数                    |
| `addressSpace`          | string  | 是   | BIN / HEX 的默认空间 ID，必须存在于 `addressSpaces` |
| `loadAddress`           | integer | 是   | BIN 的默认装载地址，必须位于默认空间范围内          |

- 空间 ID 为非空、区分大小写的稳定字符串，仅在当前固件属性内有效；模型按属性名与空间 ID 映射实际存储器。
- `start`、`loadAddress` 为非负安全整数，`start + size` MUST 为安全整数；地址和长度统一以字节计。
- 一个空间的有效范围为 `[start, start + size)`；装载地址是该空间内的绝对字节地址，不相对 `start` 再次偏移。
- 同一空间内每段完整字节范围必须落在声明范围内；不同空间允许使用相同数值地址。
- 地址空间与范围声明只描述该属性允许装载的位置；模型映射 MUST 与声明一致。
- 文件型默认值使用 `package` 模式；清单默认值不绑定宿主项目，`nullable: true` 时允许 `null`。

### 来源与实例覆盖

持久类型 `ResourceReference`、`FirmwareFileReference` 和 `FirmwareReference` 见 [RFC 0024](./0024-fused-schematic-format.md)。

| 引用字段       | 类型    | 必填 | 约束                                                                  |
| -------------- | ------- | ---- | --------------------------------------------------------------------- |
| `mode`         | enum    | 是   | 固定资源使用带路径文件名的 `file` / `package`；宿主项目使用 `project` |
| `src`          | string  | 条件 | 固定资源时要求此字段，含义沿用资源引用；项目引用不含此字段            |
| `projectId`    | string  | 条件 | 项目引用时要求此字段，宿主提供的非空、区分大小写的稳定身份            |
| `addressSpace` | string  | 否   | BIN / HEX 文件或项目产物的空间覆盖，必须引用当前属性声明的空间        |
| `loadAddress`  | integer | 否   | BIN 文件或项目产物的基址覆盖，非负安全整数，必须位于所选空间内        |

- 文件和项目引用的空间覆盖省略时使用属性 `addressSpace`；BIN 基址覆盖独立省略时使用属性 `loadAddress`，不得根据所选空间起始地址自动修正基址。
- BIN 的第 `i` 个字节装载到所选空间的 `loadAddress + i`；文件或项目产物的完整字节长度参与范围校验。
- HEX 文件及项目产物保留记录中的绝对地址，允许空间覆盖；HEX / ELF 均拒绝 `loadAddress` 覆盖，ELF 同时拒绝 `addressSpace` 覆盖。
- 项目引用保存 `mode`、`projectId` 及当前格式允许的覆盖，项目名称、构建目标、临时产物路径和解析出的装载区域均不进入引用。
- 装载地址与 MCU 启动位置独立，复位向量和启动流程由器件模型负责。

### 项目产物

```ts
interface FirmwareArtifact {
  readonly format: 'bin' | 'hex' | 'elf';
  readonly data: Uint8Array;
}
```

- 宿主通过 [RFC 0025](./0025-fused-runtime.md) 的项目服务返回格式和原始产物字节；格式分别表示 BIN、Intel HEX 和 ELF，地址配置由编辑器管理。
- 框架捕获独立字节快照并执行 `maxBytes` 检查，再按声明格式解码；解码失败明确报告，不尝试其他格式继续装载。

### 运行时镜像

```ts
interface FirmwareSegment {
  readonly addressSpace: string;
  readonly address: number;
  readonly data: ReadonlyBytes;
}
interface FirmwareImage {
  readonly segments: readonly FirmwareSegment[];
}
```

- 框架统一解析固件来源，将 BIN / Intel HEX / ELF 转成 `FirmwareImage`；每段以声明的空间 ID、绝对字节地址和只读字节快照表达，保留分段，不为地址空洞分配填充字节。
- `ReadonlyBytes` 复用现行[核心只读字节快照合同](../spec/javascript/interfaces.rst)；镜像的段数组、段描述及字节在捕获后保持只读，调用 `data.slice()` 可取得独立可写副本。
- 段数组及每段 `data` 非空，`address` 为非负安全整数，完整段范围 MUST 位于对应声明空间内；同一空间内的段范围 MUST NOT 重叠，段数组按空间 ID 的 UTF-16 代码单元顺序、段起始地址升序排列。
- JavaScript 模型工厂从 `ctx.props.<属性名>` 取得 `FirmwareImage`；空值仅在属性允许时交付 `null`。该复合属性由工厂消费，模型 IR MUST NOT 声明同名 DDL 属性。
- 工厂按属性名和空间 ID 映射模型内存，将绝对地址转换为目标内存偏移，使用现有 `loadBytes` 在首次推进前完成装载；模型保留复位向量和启动位置的控制权。

### 格式与空间转换

- 固定资源按可靠文件名的最后一个扩展名忽略 ASCII 大小写识别：`.bin` 为 BIN，`.hex` / `.ihx` 为 Intel HEX，`.elf` / `.axf` 为 ELF；引用不增加格式字段。
- `file` / `package` 使用 `src` 路径最后一段的文件名；`inline` 是 base64 文本，`store` 是宿主资源库标识，两者缺少本合同可用的文件名，在固件中按 `firmware/unknown-format` 拒绝；未知扩展名同样拒绝，不根据内容、媒体类型或标题猜测格式。
- 项目产物以宿主返回的 `format` 为准；格式识别后执行对应解析，内容与格式不符时按 `firmware/invalid-format` 拒绝，保持原引用。
- BIN 原始字节生成一个段，空间和基址由编辑器按属性默认值及实例覆盖确定。
- HEX 校验记录长度、校验和、记录类型、地址及结束记录；扩展段地址和扩展线性地址参与绝对地址计算，全部数据记录进入所选空间，保留数值地址与空洞；入口记录仅校验，不改变模型启动位置。
- ELF 接受已链接的可执行镜像 `ET_EXEC`，支持 ELF32 / ELF64 及两种字节序；文件结构、段表、文件内范围和地址整数均须合法，需要动态链接或装载时重定位的镜像按格式错误拒绝。
- ELF 仅将 `PT_LOAD` 的 `p_filesz` 文件字节作为装载数据，以 `p_paddr` 为绝对装载地址；要求 `p_filesz <= p_memsz`，零文件长度段跳过，`p_vaddr`、入口地址和额外 `p_memsz` 区域由模型及固件启动流程处理。
- 每个 ELF 装载段的完整范围须恰好落入一个声明空间；无匹配按 `firmware/out-of-range` 拒绝，多匹配按 `firmware/ambiguous-address-space` 拒绝，不用默认空间消除歧义，也不拆段跨空间装载。
- 所有格式在转换后统一检查非空镜像、完整范围和同空间段重叠；相邻段 MAY 合并，空洞保持未写入，错误时不交付部分镜像。

## 运行时

### 解析与运行快照

- 运行准备时，框架解析全部固件引用，完成镜像结构、空间、段范围和重叠校验后才执行任何模型工厂；失败保留引用并报告准备错误。
- 传入工厂的是已解析的镜像快照；同次运行中，编辑器装载区域与模型工厂读取同一份镜像内容的独立只读快照。
- 项目后续构建或文件变更不替换当前运行镜像；运行与暂停时，装载面板展示当前会话镜像，`reset` 沿用已捕获内容，重新解析遵循 [RFC 0024](./0024-fused-schematic-format.md) 的新运行准备边界。

### 来源选择与打开项目

- 编辑器提供一个下拉框，按来源分组混合列出宿主项目、工程文件和内置固件，并提供“选择其他文件…”入口；内置文件沿用 [RFC 0020](./0020-unified-device-package.md) 的 `assets/` 列举规则。
- 打开下拉框时通过 [RFC 0025](./0025-fused-runtime.md) 的 `projects.list()` 读取当前项目列表；未提供项目来源时省略该分组。
- 选择项目保存项目引用，选择文件保存资源引用；均按 [RFC 0024](./0024-fused-schematic-format.md) 的文档属性事务提交，支持统一撤销。
- 当前值为项目引用时，下拉框右侧显示 Codicons `folder-open` 图标按钮，提示和可访问名称为“打开项目”；文件或空值隐藏此按钮。
- 点击打开按钮按当前 `projectId` 触发 `onDidRequestOpenProject`，由宿主打开项目；保持属性、文档历史和仿真状态不变。
- 项目来源未提供或已选项目不存在时，保留引用并显示无法解析的状态；列表读取失败明确显示错误，允许重试，不自动改选其他来源。

### 展开装载配置

- 下拉框最右侧提供 Codicons `settings-gear` 图标按钮，提示和可访问名称为“装载配置”；选中项目时排列为下拉框、打开项目按钮、装载配置按钮。
- 点击装载配置按钮，在当前属性下方展开配置，再次点击收起；展开状态属于编辑器会话，不写入文档或撤销历史。
- BIN 文件和 BIN 项目产物均展示所选空间的名称、ID、有效范围和可编辑基址；只有一个空间时只读展示空间，多个空间时允许选择。
- 基址输入接受十进制或 `0x` 前缀十六进制，确认为非负安全整数后保存 JSON 数字；空间与基址的一次有效编辑作为一个属性事务提交。
- HEX 文件和项目产物可选择目标空间，只有一个空间时只读展示；段地址与 ELF 的全部装载区域只读，允许显示多个段；待解析显示加载状态，失败显示错误，不以默认基址代替解析结果。
- 已保存基址而产物变为 HEX / ELF，或已保存空间覆盖而产物变为 ELF 时，保留引用并报告配置不适用；重新选择来源会创建不含旧覆盖的新引用，再按当前格式展示配置。
- 空值展开后提示“未选择固件”；运行与暂停期间允许展开和打开项目，来源、空间与基址保持只读。

## 校验

| 诊断码                             | 条件与行为                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `package/invalid-manifest`         | 空间映射为空、空间描述或默认空间/基址非法，拒绝装载包                                      |
| `schema/invalid-value`             | 固件引用结构非法、覆盖不适用于当前格式或非固件属性、空间未知，拒绝非法编辑或报告文档错误   |
| `firmware/unknown-format`          | 固定资源无可靠文件名或扩展名未知，保留引用并拒绝运行准备                                   |
| `firmware/invalid-format`          | 内容、记录、段表或装载形式不符合所选格式，保留引用并拒绝运行准备                           |
| `firmware/ambiguous-address-space` | ELF 装载段完整范围匹配多个声明空间，拒绝运行准备                                           |
| `firmware/invalid-image`           | 镜像结构非法、段字节为空、引用未知空间或同空间段重叠，拒绝运行准备                         |
| `firmware/out-of-range`            | 基址或任一完整装载段超出声明范围，拒绝非法编辑或运行准备                                   |
| `firmware/project-list-failed`     | 项目列表读取失败或列表非法，保留引用并显示错误，合同见 [RFC 0025](./0025-fused-runtime.md) |
| `firmware/project-resolve-failed`  | 项目产物获取失败或结构非法，保留引用并显示错误，合同见 [RFC 0025](./0025-fused-runtime.md) |

- 无法解析的已保存引用保持原样并显示错误；就地输入错误不提交，已有值和历史保持不变。
- 文件读取继续执行资源存在、访问范围、发布摘要及 `maxBytes` 检查，规则见 [RFC 0020](./0020-unified-device-package.md)。

## 示例

完整属性描述见 [全字段器件清单](./examples/0020-device-package.json) 的 `properties.firmware`，包含全部通用字段、空间描述与 BIN 默认地址；固定文件覆盖和宿主项目分别见 [完整来源示例](./examples/0026-firmware-sources.json)，项目实例见 [完整文档](./examples/0024-fused-schematic.json)。全字段清单中的固件用于展示属性结构，非轻触开关的运行功能。

来源示例的 BIN 文件和 BIN 项目产物基址均为 `256`，在 `code` 空间的第一个字节地址为 `0x0100`；该空间范围为 `0x0000–0x1FFF`，允许装载的 BIN 最大长度为 `7936` 字节。

对于地址原点为 `0` 的模型内存 `code`，工厂可按以下片段装载；`data.slice()` 交付给核心的是独立字节副本，段的绝对地址直接作为该内存偏移。

```js
for (const segment of ctx.props.firmware?.segments ?? []) {
  if (segment.addressSpace !== 'code') throw new Error('Unsupported firmware address space');
  ctx.loadBytes('code', segment.data.slice(), segment.address);
}
```

`[folder-open]` 和 `[settings-gear]` 表示对应的 Codicons 图标按钮。

```text
固件    [ main.bin                 ▾ ] [settings-gear]
        ┌ 装载配置 ──────────────────────────┐
        │ 地址空间    程序存储器（code）     │
        │ 有效范围    0x0000–0x1FFF           │
        │ 装载地址    [0x0100             ]  │
        └────────────────────────────────────┘

固件    [ controller               ▾ ] [folder-open] [settings-gear]
```

## 范围

- 包资源、属性默认值和资源浏览由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 持久引用类型和属性事务由 [RFC 0024](./0024-fused-schematic-format.md) 规定。
- 宿主项目列表、产物获取、打开项目事件及运行生命周期由 [RFC 0025](./0025-fused-runtime.md) 规定。

## 关联

- [RFC 0009](./0009-device-properties.md)：既有属性基础；本文为尚未实现的融合合同增加独立固件属性，不改变既有二进制属性。
