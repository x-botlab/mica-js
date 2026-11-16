# 统一器件包

- Start Date: 2026-11-15
- Reference Issues: —（尚未实现）
- Implementation PR: —（尚未实现）

规定单器件发布包的清单、入口、资源与不可变发布身份，以及 ZIP、本地目录和 Web 逐文件加载之间的一致性。本文为待实现的合同草案；融合运行的装配入口见 [RFC 0025](./0025-fused-runtime.md)。本文中的 MUST / MUST NOT 表示强制要求，SHOULD 表示推荐，MAY 表示可选能力。

## 声明

### 包身份与文件

- 一个 ZIP MUST 对应一个器件，包根的 `package.json` 是唯一器件清单。
- `publisher` 是发布者命名空间，`name` 是该发布者下的器件名称；两者必填，均匹配 `[a-z0-9]+(?:-[a-z0-9]+)*`。
- 器件 ID 由 `publisher` 与 `name` 以冒号连接得到，例如 `example:button`；文档、注册表与运行时统一使用该完整 ID 引用器件。
- 清单只保存身份的两个组成字段；修改任一字段即定义另一个器件身份，展示名称由 `displayName` 独立管理。
- `version` 使用完整 SemVer；同一器件 ID 的同一版本发布后内容保持不变。
- 文件路径使用区分大小写的包根相对 POSIX 路径；拒绝空段、`.`、`..`、反斜杠、绝对路径和规范化后重复的路径。
- 包只包含普通文件；读取、解包和缓存遵守宿主的文件数、单文件及总字节额度。

### 清单

| 字段                     | 类型   | 必填 | 约束                                                                                                      |
| ------------------------ | ------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `publisher`              | string | 是   | 发布者命名空间                                                                                            |
| `name`                   | string | 是   | 发布者下的器件名称                                                                                        |
| `version`                | string | 是   | 器件发行版本                                                                                              |
| `description`、`license` | string | 否   | 说明                                                                                                      |
| `engines.mica`           | string | 是   | 宿主 API 的 SemVer 兼容范围                                                                               |
| `displayName`            | string | 是   | 展示名称                                                                                                  |
| `icon`                   | string | 否   | 器件图标的包根相对 PNG 或自包含静态 SVG 路径，须列入发布文件清单                                          |
| `designatorPrefix`       | string | 否   | 非空位号前缀；缺省 `U`                                                                                    |
| `entries`                | object | 否   | 预留 `view3d` 到包内 `.js` 的映射                                                                         |
| `properties`             | object | 否   | 属性描述映射，缺省空；基础值与约束见 [RFC 0009](./0009-device-properties.md)                              |
| `pins`                   | object | 否   | 引脚 ID 到 `{ label?, description? }` 的映射                                                              |
| `model`                  | object | 条件 | 声明引脚时须提供；包含模型入口与公共接口，字段见下表                                                      |
| `view2d`                 | object | 条件 | 加入 2D 场景时要求此声明；包含 `geometry` 与可选 `entry`，见 [RFC 0022](./0022-device-2d-presentation.md) |
| `view`                   | object | 否   | 视图 ID 到 HTML 视图条目的映射；字段见下表，容器合同见 [RFC 0023](./0023-device-html-ui.md)               |

| 模型字段  | 类型   | 必填 | 约束                                                                    |
| --------- | ------ | ---- | ----------------------------------------------------------------------- |
| `entry`   | string | 是   | 模型入口的包根相对 `.js` 路径                                           |
| `types`   | object | 否   | 公共载荷具名类型映射，缺省空；见 [RFC 0021](./0021-device-model-api.md) |
| `methods` | object | 否   | 公共方法声明映射，缺省空；见 [RFC 0021](./0021-device-model-api.md)     |
| `events`  | object | 否   | 公共事件声明映射，缺省空；见 [RFC 0021](./0021-device-model-api.md)     |

| HTML 视图条目字段 | 类型   | 必填 | 约束                                                                        |
| ----------------- | ------ | ---- | --------------------------------------------------------------------------- |
| `title`           | string | 是   | 非空标题，用于视图标题、悬停提示与可访问名称                                |
| `entry`           | string | 是   | 包根相对 HTML 路径                                                          |
| `defaultLocation` | enum   | 否   | `sidebar` / `floating`，缺省 `sidebar`；实例布局覆盖该初值                  |
| `icon`            | string | 否   | 编辑器提供的 VS Code Codicons 图标名，例如 `terminal`；缺省使用通用视图图标 |

- 属性键、方法键、公共类型键和视图 ID 匹配 `[A-Za-z][A-Za-z0-9]*`；事件键采用 `onDidXxx` 形式。
- 视图 ID 是布局引用的稳定身份；HTML 视图初始顺序采用视图 ID 的 ASCII 升序，实例布局可覆盖顺序。
- 根 `icon` 用于器件库、对象列表与属性面板中的器件标识；宿主保持图片比例缩放到方形区域，画布外观仍由 `view2d` 声明。
- 根 `icon` 省略时显示编辑器内置的通用器件图标；显式声明的路径和资源沿用包文件校验规则，格式或图片解码失败时报告 `package/invalid-icon` 并显示资源错误，不按省略图标处理。
- `view.*.icon` 的图标资源由编辑器统一提供，其值 MUST 是编辑器支持的 Codicons 图标名，非法名称按清单错误报告；根 `icon` 则引用器件包内图片。
- 引脚 ID 是合法、区分大小写的模型引脚名，与模型声明同名绑定；显示文字和封装脚号通过 `label` 或 `description` 表达。
- 清单 `pins` 与模型 IR 的引脚集合 MUST 完全一致；省略 `pins` 视为空集合，电气资源和内部连接由 [RFC 0021](./0021-device-model-api.md) 规定。
- `model` 按能力声明；纯展示器件 MAY 省略模型和引脚，声明引脚的器件 MUST 提供 `model`。
- 声明 `model` 时 MUST 提供 `model.entry`；公共类型、方法与事件分别位于 `model.types`、`model.methods`、`model.events`。
- 声明 `view2d` 时 MUST 提供 `view2d.geometry`，取内联 `Geometry2D` 或包根相对 JSON 路径；HTML 视图的容器合同见 [RFC 0023](./0023-device-html-ui.md)。
- 固定二维外观由解析后的 `view2d.geometry.bodyImage` 声明；宿主直接加载图片，动态覆盖或业务交互按需提供 `view2d.entry`。
- 示例将展示资源放在 `views/`：二维几何和脚本使用 `views/2d/geometry.json`、`views/2d/index.js`，单个 HTML 视图使用 `views/index.html`；目录是组织约定，加载仍以声明路径为准。
- 每个 JS 入口是自包含 ESM；普通代码依赖在构建时打包，运行所需框架能力由宿主注入。
- HTML 可引用包内构建后的 JS、CSS 和资源，资源路径按引用文件的所在目录解析。
- HTML 与 CSS 的相对引用先归一化，解析结果 MUST 留在包根且对应 `files` 中的记录；清单路径和 `read` 参数使用规范化的包根相对形式。
- 清单表中的字段直接位于根对象，模型字段位于 `model`，HTML 视图条目位于 `view.<视图 ID>`；各结构对象拒绝未知字段，`engines.mica` 中的 `mica` 是宿主引擎名。
- 根字段以器件合同解释；其他包管理字段可保留，但不得覆盖器件字段的含义，加载器 MUST NOT 执行安装脚本。

### 属性资源

- 文档只保存属性覆盖值，缺省键使用清单默认值；同一实例只有一个属性命名空间。
- `image` / `binary` 沿用 `{ src, mode }`；在 [RFC 0009](./0009-device-properties.md) 的模式之外增加 `mode: "package"`，其 `src` 为包根相对路径。
- `firmware` 表达 MCU 的程序来源，复用资源属性的通用描述字段与 `maxBytes`；属性内地址空间、引用与选择交互见 [RFC 0026](./0026-firmware-properties.md)。
- 包中声明的文件型默认资源 MUST 使用 `package` 模式；实例的 `file` 引用以宿主明确提供的工程根为基准。
- 必需属性由默认值或实例覆盖提供；既无默认值又无覆盖值时拒绝创建实例，显式 `null` 仅在属性允许时有效。
- 属性可额外声明 `group: string`、`order: number`；`order` 为非负整数，仅影响面板排序。
- 本合同对非法属性描述和默认值采用拒绝装载策略，而非忽略字段后继续。
- 模型和展示获得相同取值的独立只读属性快照；`image` / `binary` 在工厂执行前解析为只读字节快照，`firmware` 解析为 [RFC 0026](./0026-firmware-properties.md) 的 `FirmwareImage`，文档仍保留资源引用。
- DDL 使用的属性，其类型、可空性和默认值 MUST 与清单一致；展示专用属性由清单管理。

### 资源选择器

| 属性描述字段 | 类型     | 必填 | 约束                                                                        |
| ------------ | -------- | ---- | --------------------------------------------------------------------------- |
| `extensions` | string[] | 否   | 仅用于 `binary` 的文件扩展名过滤器，例如 `[".bin", ".hex"]`；省略表示不过滤 |

- `extensions` 声明时为非空数组，每项匹配 `\.[A-Za-z0-9]+`，按忽略 ASCII 大小写后的值去重；非法声明按 `package/invalid-manifest` 拒绝装载。
- 选择器使用文件名最后一个 `.` 起的扩展名忽略 ASCII 大小写匹配，多个值表示任选其一；无扩展名文件仅在未声明过滤器时显示。
- 过滤器同时用于工程文件选择和包内资源浏览，仅筛选候选项；不参与默认值、已保存引用或 `inline` / `store` 资源的有效性判断。
- 编辑器为资源属性提供工程文件和本器件内置资源两个来源；内置资源从当前锁定包的发布文件清单中递归列出 `assets/` 下的文件，目录名匹配区分大小写。
- `image` 选择器仅展示可识别的图片并提供预览；`binary` 选择器按 `extensions` 筛选文件。无候选文件时显示“无内置资源”。
- 选择内置资源保存 `{ src, mode: "package" }`，`src` 保留包根相对路径；选择工程文件保存 `file` 引用。包内文件保持只读，选择操作不复制文件。
- 读取仍校验文件存在、访问范围、发布摘要及 `maxBytes`；图片另外校验解码与 `maxPixels`，二进制内容由器件解析并明确报告错误。
- `assets/` 仅限定选择器的列举范围；底图、HTML 及其依赖、默认值和已保存包引用继续使用各自的包内路径规则。

### 发布文件清单

发布服务提供包外的 `release.json`，记录完整包内容；它自身与 ZIP 文件均不进入 `files`，避免自引用。

| 字段                | 类型    | 必填 | 约束                                                                 |
| ------------------- | ------- | ---- | -------------------------------------------------------------------- |
| `id`                | string  | 是   | 等于包清单的 `publisher:name`                                        |
| `version`           | string  | 是   | 等于包清单的 `version`                                               |
| `files`             | object  | 是   | 全部包内文件路径到 `{ size, integrity }` 的映射，包含 `package.json` |
| `files.*.size`      | integer | 是   | 文件原始字节数，非负安全整数                                         |
| `files.*.integrity` | string  | 是   | `sha256:` 加 64 位小写十六进制摘要                                   |

- 发布身份是 `release.json` 经 JSON Canonicalization Scheme（RFC 8785）规范化后的 UTF-8 字节 SHA-256，格式同 `integrity`。
- 发布文件清单 MUST 拒绝重复 JSON 键和非法路径；清单中记录的是未压缩文件字节。
- ZIP 压缩参数不影响发布身份；下载索引 MAY 另外记录 ZIP 原始字节摘要。
- ZIP、解包文件服务与本地安装 MUST 对应同一份发布文件清单，禁止分别重建同版本产物。
- 文档锁定发布身份；索引地址、镜像地址和 ZIP 下载地址由宿主解析。

### 读取接口

```ts
interface DeviceLock {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
}
interface PackageFile {
  readonly size: number;
  readonly integrity: string;
}
interface PackageFiles {
  readonly lock: DeviceLock;
  readonly files: Readonly<Record<string, PackageFile>>;
  read(path: string): Promise<Uint8Array>;
}
interface DeviceRegistry {
  open(lock: DeviceLock): Promise<PackageFiles>;
}
```

`DeviceLock.id` 使用完整 `publisher:name`；`read` 返回独立字节，只有长度与文件摘要均匹配时才成功。资源 URI 的读取能力由 [RFC 0019](./0019-host-fs.md) 承担。

## 运行时

1. 按锁定的 ID、版本和摘要解析发布文件清单，校验发布身份。
2. 读取并验证 `package.json`，从 `publisher` 与 `name` 派生完整 ID 并与锁定 ID、发布清单 ID 比较，检查版本、宿主 API 范围及入口引用。
3. 为当前模式读取所需入口和资源，每个文件使用前验证字节长度与摘要。
4. 在获准的执行环境加载代码；安装与静态校验阶段保持代码不执行。

- Web 注册表 SHOULD 同时提供 ZIP 下载和逐文件访问；2D 加载不要求下载完整 ZIP、读取 `view3d` 或解码 GLB。
- 首次打开 HTML 视图时才读取其入口与所需资源；所有读取保持锁定的包根。
- 同一发布的只读资源 MAY 跨实例共享缓存；每个接收方的可变字节所有权仍独立。
- 开发目录通过显式开发解析形成内容快照；变更内容产生新摘要，更新依赖是显式文档编辑。
- 缺包、摘要不符和不兼容 API MUST 明确失败，已有文档数据保持原样。

## 校验

| 诊断码                       | 条件                                              |
| ---------------------------- | ------------------------------------------------- |
| `package/invalid-manifest`   | 清单结构、身份、SemVer 或属性非法                 |
| `package/unsupported-engine` | 宿主 API 不满足兼容范围                           |
| `package/invalid-path`       | 路径越界、重复、非法文件种类                      |
| `package/missing-entry`      | 所声明入口或静态资源未列入发布清单                |
| `package/invalid-icon`       | 器件图标不是 PNG 或自包含静态 SVG，或图片解码失败 |
| `package/integrity-mismatch` | 发布清单或文件摘要、长度不符                      |
| `package/not-found`          | 锁定的发行物或文件缺失                            |
| `package/resource-limit`     | 包或文件超过宿主额度                              |

## 示例

完整器件清单见 [全字段 package.json 示例](./examples/0020-device-package.json)，覆盖全部清单字段、属性描述和载荷类型结构，根 `icon` 引用器件图片，`view.monitor.icon` 使用 Codicons 名称，固件属性包含地址空间及默认基址；项目引用示例见 [完整文档](./examples/0024-fused-schematic.json)，BIN 地址覆盖见 [RFC 0026](./0026-firmware-properties.md)。数值属性的 `min` 与 `exclusiveMin` 分别展示在不同属性中。几何文件的全字段示例见 [RFC 0022](./0022-device-2d-presentation.md)。名称和版本用于说明结构，不代表已发布的发行物。

对应的发布文件清单如下。大小与摘要均为占位示意，实际发布时按构建文件的原始字节填写。

```json
{
  "id": "example:button",
  "version": "1.0.0",
  "files": {
    "package.json": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "model.js": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "views/2d/index.js": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "views/3d/index.js": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "views/2d/geometry.json": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "assets/body.svg": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "assets/device-icon.svg": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "views/index.html": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "assets/icon.png": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "assets/profile.bin": {
      "size": 0,
      "integrity": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    }
  }
}
```

## 范围

- 模型方法、事件与二进制所有权由 [RFC 0021](./0021-device-model-api.md) 规定。
- 2D 几何与绘制由 [RFC 0022](./0022-device-2d-presentation.md) 规定。
- HTML 容器与桥接由 [RFC 0023](./0023-device-html-ui.md) 规定。
- 文档依赖锁定由 [RFC 0024](./0024-fused-schematic-format.md) 规定。
- 固件属性、地址空间与装载配置交互由 [RFC 0026](./0026-firmware-properties.md) 规定。

## 关联

- [RFC 0011](./0011-package-format.md)：既有多内容包合同；本文为融合模式建立独立的单器件发行合同。
- [RFC 0025](./0025-fused-runtime.md)：融合模式装配与验收入口。
