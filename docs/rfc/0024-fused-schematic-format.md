# 融合原理图文档

- Start Date: 2026-11-15
- Reference Issues: —（尚未实现）
- Implementation PR: —（尚未实现）

规定 `.sch` 第二版中的器件身份、二维摆放、显式连接、依赖锁定、运行显示和实例视图布局。本版把电气与展示保存为一份 2D 文档；3D 文档采用独立合同，当前不定义。本合同尚未实现。MUST / MUST NOT 为强制要求，SHOULD 为推荐，MAY 为可选。

修订（2026-11-17）：按 [RFC 0026](./0026-firmware-properties.md) 增加程序引用，装载方式由锁定清单决定；既有固件引用继续有效。增加 `designatorOffset` 保存独立拖动的位号位置，相关交互已在本地实现，尚未关联实现 PR。

## 声明

### 根结构

| 字段           | 类型    | 必填 | 约束                                         |
| -------------- | ------- | ---- | -------------------------------------------- |
| `version`      | integer | 是   | 固定 `2`                                     |
| `dependencies` | object  | 是   | 器件 ID 到 `{ version, integrity }` 的锁定表 |
| `instances`    | array   | 是   | 全部器件与纯展示对象，数组顺序为绘制顺序     |
| `nodes`        | array   | 是   | 显式分支和自由端点                           |
| `wires`        | array   | 是   | 连接边与中间折点                             |
| `labels`       | array   | 是   | 挂在连接端上的网名声明                       |
| `references`   | array   | 是   | 连接端的理想对地电压参考及可选内置符号       |
| `display`      | object  | 否   | 运行展示配置                                 |

- 文件是 UTF-8 JSON 单对象，拒绝重复 JSON 键、未知结构字段和非有限数值。
- 宿主维护文档身份和存储位置；编辑器接收文档数据，文档内实例使用独立稳定 ID。
- 实例、节点、导线、标签、参考源的 ID 为全篇唯一的 UUID v4；位号与网名独立保存。
- 每个依赖键是由清单 `publisher` 与 `name` 派生的完整 `publisher:name`，锁定精确发行版本与发布文件清单摘要，语义见 [RFC 0020](./0020-unified-device-package.md)。
- 同一 ID 在文档内解析为一个版本，实例 `device` 保存同一完整器件 ID，不拆分保存发布者、名称或下载地址。
- `display` 缺省 `{ body: true, designators: true }`；运行接线与引脚辅助固定隐藏。

### 实例与摆放

```ts
type ResourceReference =
  | { readonly mode: 'package'; readonly src: string }
  | { readonly mode: 'asset'; readonly assetId: string; readonly name: string };
type ProgramFileReference = ResourceReference & {
  readonly addressSpace?: string;
  readonly loadAddress?: number;
};
type ProgramReference =
  | ProgramFileReference
  | {
      readonly mode: 'project';
      readonly projectId: string;
      readonly name?: string;
      readonly addressSpace?: string;
      readonly loadAddress?: number;
    };
type PropertyValue = string | number | boolean | null | ResourceReference | ProgramReference;
interface Point {
  readonly x: number;
  readonly y: number;
}
interface Placement2D extends Point {
  readonly rotation: number;
  readonly width?: number;
  readonly height?: number;
}
interface FusedInstance {
  readonly id: string;
  readonly device: string;
  readonly designator?: string;
  readonly designatorOffset?: Point;
  readonly placement: Placement2D;
  readonly properties?: Readonly<Record<string, PropertyValue>>;
  readonly display?: { readonly body?: boolean };
  readonly viewLayout?: InstanceViewLayout;
}
```

- `PropertyValue` 使用 [RFC 0009](./0009-device-properties.md) 的持久属性值，包资源按 [RFC 0020](./0020-unified-device-package.md) 扩展，程序按 [RFC 0026](./0026-firmware-properties.md) 扩展。
- `project` 仅用于 `program`；BIN 允许空间与基址覆盖，HEX 仅允许空间覆盖，省略覆盖使用属性 `defaults`；ELF 和文件集拒绝覆盖。装载方式来自属性声明，不写入引用。
- `package` 指包内文件或程序根目录，`asset` 保存资产身份与带扩展名的名称，文件集资产为 ZIP；项目保存非空 `projectId` 与可选展示名称 `name`，解析失败保留引用，产物与打开状态属于会话。
- 坐标单位是场景 mm，`x` 向右、`y` 向下，旋转为顺时针度数，绕器件局部原点。
- 自由展示对象的区域同样使用场景单位表达布局，不推断其具有真实封装尺寸。
- `physical` 器件省略 `width` / `height`，尺寸来自包几何；`flexible` 同时提供有限正数宽高。
- 自由区域将几何 `bounds` 的左上角映射到摆放原点，先按宽高缩放再绕摆放原点旋转；同一变换用于锚点、绘制与输入。
- 物理器件采用局部原点平移加旋转；原点约定见 [RFC 0022](./0022-device-2d-presentation.md)。
- 位号省略时由编辑器在添加时按前缀分配最小未占用正整数，并保存结果；已有文档加载不自动补写。
- 已保存位号在实例间唯一；缺省位号只按实例 ID 展示，不改变实例身份；`designatorOffset` 为器件局部 mm 偏移，缺省 `{ x: 0, y: 0 }`，相对包几何位号锚点，跟随器件变换，独立拖动只修改该偏移。
- 属性只保存覆盖值；运行与暂停期间保持只读。
- 实例 `display.body` 覆盖全局 `display.body`；编辑态始终显示底图、引脚、导线和位号。
- 标注、图片和独立仪表也使用实例记录，由其器件包决定是否具有模型。

### 实例视图布局

```ts
interface SidebarViewLayout {
  readonly height: number;
  readonly collapsed: boolean;
}
interface FloatingBounds extends Point {
  readonly width: number;
  readonly height: number;
}
interface HtmlViewLayout extends SidebarViewLayout {
  readonly viewId: string;
  readonly location: 'sidebar' | 'floating';
  readonly floatingBounds?: FloatingBounds;
}
interface InstanceViewLayout {
  readonly properties: SidebarViewLayout;
  readonly views: readonly HtmlViewLayout[];
}
```

- `viewLayout` 按器件实例 ID 独立保存；相同器件类型的不同实例各有自己的布局，切换选择或保存重开时分别恢复，恢复默认布局只影响目标实例。
- `viewLayout.properties` 对应内置属性 View，固定在顶部；`views` 的 `viewId` 只引用本器件清单 `view` 中的视图 ID，每个 ID 至多出现一次。
- `views` 数组顺序决定 HTML 视图顺序，包含当前归属浮动的视图，便于停靠时恢复原位置；侧栏与浮动入口分别按该顺序筛选。
- 省略 `viewLayout` 使用清单与编辑器初值；未出现在 `views` 的已声明视图按视图 ID 的 ASCII 升序追加，并采用其默认位置、展开状态与初始高度。
- `height` 是侧栏视图展开时的内容区高度，折叠时保留；有限正数，单位 CSS px，可用空间不足时由容器滚动承载。
- `floatingBounds` 是最近的浮动矩形，`x`、`y` 相对编辑器可用区域左上角，单位 CSS px；坐标有限，宽高为有限正数。
- `floatingBounds` 首次浮动前可省略，停靠后保留；首次定位与恢复时可见区域适配见 [RFC 0023](./0023-device-html-ui.md)。
- 页面是否打开、焦点、端口、页面内部标签页与滚动状态及模型数据不进入布局；读取、恢复布局不自动改写文档。

### 连接图

```ts
type Endpoint =
  | { readonly kind: 'pin'; readonly instance: string; readonly pin: string }
  | { readonly kind: 'node'; readonly node: string };
interface ConnectionNode extends Point {
  readonly id: string;
  readonly kind: 'junction' | 'free';
}
interface ConnectionWire {
  readonly id: string;
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly bends: readonly Point[];
}
interface NetLabel {
  readonly id: string;
  readonly target: Endpoint;
  readonly name: string;
  readonly offset?: Point;
}
interface VoltageReference {
  readonly id: string;
  readonly target: Endpoint;
  readonly voltage: number;
  readonly symbol?: 'power' | 'ground';
  readonly rotation?: number;
  readonly label?: { readonly name: string; readonly offset?: Point };
}
interface FusedDocument {
  readonly version: 2;
  readonly dependencies: Readonly<
    Record<string, { readonly version: string; readonly integrity: string }>
  >;
  readonly instances: readonly FusedInstance[];
  readonly nodes: readonly ConnectionNode[];
  readonly wires: readonly ConnectionWire[];
  readonly labels: readonly NetLabel[];
  readonly references: readonly VoltageReference[];
  readonly display?: { readonly body?: boolean; readonly designators?: boolean };
}
```

- 引脚连接端由 `(instance, pin)` 标识，几何位置由摆放与包锚点推导；节点连接端由 `node` ID 标识。
- 导线端点引用身份，`bends` 仅保存中间折点；完整折线为推导的首端、折点和推导的末端。
- 每条边的两个连接端必须不同；相同连接端上的所有边直接连通。
- `junction` 与 `free` 都是显式连接节点；前者绘制分支点，后者表示可编辑的自由端点。
- 几何交叉、重叠或经过引脚均不产生新的连接；用户接入时必须提交引用修改或分支节点。
- 孤立引脚具有开放状态；自由节点度为一时为悬空线端，度为零时为未接入节点。
- 普通标签 `name` 与参考内嵌的 `label.name` 均为非空字符串，按精确值合并同名网络；`offset` 只改变显示位置。
- 同一连通分量出现多个不同名称是命名冲突；同名合并后相冲突的理想电压参考是电气配置错误。
- `voltage: 0` 表达全局地参考；有限非零值表达理想电源，未引用参考的网络不隐含接地或供电。
- `references.symbol` 选择编辑器内置的 `power` 电源符号或 `ground` 接地符号；省略时只保存电压约束，不绘制符号；这些符号不占用器件实例或包依赖。
- `target` 是符号的接线锚点，位置由节点坐标或器件引脚几何推导；独立放置使用节点，导线仍通过该连接端接入。
- `rotation` 为有限顺时针角度，单位度，缺省 `0`，绕锚点旋转；零度时 `power` 符号向上、`ground` 符号向下。
- `ground` 符号要求 `voltage: 0`；`power` 符号允许任意有限电压，包括零和负值；图形选择不自动修改电压。
- `references.label` 保存符号拥有的网名和偏移，仅在声明 `symbol` 时有效；内嵌网名作用于该参考的 `target`，普通网标仍由独立 `labels` 保存。
- 图形或相同电压均不代替显式网名的合并规则，名称 `VCC` 不推断电压，零电压也不推断符号。
- 符号旋转只改变图形朝向，保留锚点、连接和电压；`label.offset` 相对锚点，以场景 mm 计，缺省 `(0, 0)`，不随符号旋转。
- 四脚按钮的内部导通由器件模型按 [RFC 0021](./0021-device-model-api.md) 的有限电阻支路表达，外部文档保持四个独立引脚身份；这些支路不合并文档网络。
- 网络是连接图及名称规则的派生结果；文件不再保存另一份可编辑网络成员表。

## 运行时

### 编辑与推导

- 加载只读校验，原始数据不因诊断自动修复、改名或删除；阻止运行的错误必须可定位。
- 先解析包和全部引用，再根据显式连接边构造连通分量，按网名合并，最后附加参考电压。
- 每个推导网络包含去重后的器件引脚；纯绘图分量保留诊断和几何，但不创建电气节点。
- 孤立的引脚若被标签或参考显式引用，也参与对应电气节点的构造。
- 网络标识由排序后的稳定连接端身份确定，导线折点和视口不参与标识。
- 移动、旋转与改变显示配置只影响几何或展示；拖动连线端点等明确连接命令才改变拓扑。
- 移动器件可更新相邻折点，连接端身份保持不变；精确锚点不吸附到与脚距不兼容的网格。
- 添加、复制、删除、旋转、修改连接、显示配置和视图布局由同一个文档命令流提交，具有统一撤销历史。
- 删除器件同时移除其标签、参考及附着导线；一次撤销完整恢复这批对象。
- 复制所选子图分配新 ID 与位号，内部引用映射至副本，连接到未选中对象的边保持原对象不变且不复制。
- 文档持久内容的修改作为原子事务，准备失败时不提交内容或历史。
- 独立放置电源或地符号时，一次事务创建锚点节点和包含显式电压、符号与内嵌网名的参考记录；附着已有连接端时复用该端点，不按坐标重合自动连接；接地符号固定表示 GND，绘制与命中仅覆盖符号本身，省略电压和网名文字。
- 点击符号或其内嵌网名选择同一个参考对象，虚线选中框仅包围符号本身；单击未连接导线的引脚或参考符号的接线锚点同时进入画线状态，以对应连接端为起点，已有导线连接时保持选择，点击符号其余部分与内嵌网名只选择对象，显式画线工具仍可连接；拖动命名引脚或共享节点的网名只修改 `label.offset`。
- 独立网标由独占节点和网名构成：该节点不是分支节点，无其他网名或参考引用它，附着导线不超过一条；拖动独立网标整体平移节点与网名，`label.offset` 保持不变，附着导线随节点重新正交成形，撤销一次完整恢复原位置。
- 拖动附着引脚或共享节点的符号时，一次事务创建独立自由节点和连接原锚点的导线，并改用新节点；后续拖动仅移动独占节点并调整附着导线，原引脚、共享节点和其他附着对象保持原位；符号角度与网名偏移独立保存。
- 删除符号同时移除参考与内嵌网名；若锚点节点仍有导线、普通标签或其他参考则保留，否则一并移除；器件引脚与相邻导线保持原样。
- 复制符号包含其内嵌网名；节点锚点复制为新节点，附着引脚在宿主器件也被复制时映射到副本引脚，否则在原锚点位置创建新自由节点，不隐式复制宿主器件或外部导线。
- 副本使用新 ID，保留网名，继续参与同名合网；上述符号操作各提交一次原子事务，撤销完整恢复对象、锚点与关联。
- 内置电源与地符号由编辑器绘制，属于接线辅助层，运行态隐藏图形与对应网名，电压约束和网络连接仍然生效。
- 排序、折叠、停靠和恢复默认布局各提交一次事务；拖动调整使用临时预览，结束时一次提交，取消时不改文档。
- 编辑、运行与暂停期间均允许修改视图布局；运行与暂停仍保持器件属性和拓扑只读，布局修改及其撤销不重建模型或改变电气连接。
- 运行与暂停中的撤销、重做只执行历史顶端的布局事务；遇到需要修改器件属性或拓扑的事务时禁用该操作并提示退出运行，不跳过历史。
- 布局事务按 [RFC 0023](./0023-device-html-ui.md) 更新容器；准备失败保持原布局、页面及历史，选择与焦点是会话行为。
- 相机、选中状态、页面是否打开、浮动窗口焦点、端口及位图是宿主会话状态。

### 模式与依赖

- 添加器件前检查 `view2d.geometry` 及其声明资源，缺少几何或声明资源时拒绝添加；`view2d.entry` 按需提供，静态器件按 [RFC 0022](./0022-device-2d-presentation.md) 直接显示。
- 已有文档的包、引脚或展示缺失时保留数据并报错，修复前禁止进入运行。
- 无头执行只要求模型和拓扑能力，纯展示实例保留在文档但不创建运行实例。
- 运行与复位锁定同一批包字节和属性资源快照；重新解析可变工程资源是显式的新运行准备。

## 校验

| 诊断码                                                   | 条件                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `schema/unsupported-version`                             | 版本不是 `2`                                               |
| `schema/unknown-field`、`schema/invalid-value`           | 字段、数值或结构非法，符号、旋转、电压或内嵌网名与偏移非法 |
| `document/duplicate-id`、`document/duplicate-designator` | ID 或已保存位号冲突                                        |
| `document/unlocked-device`                               | 实例未在依赖表锁定                                         |
| `document/invalid-view-layout`                           | 视图布局字段非法、视图 ID 重复或未在所属器件声明           |
| `connection/unknown-endpoint`                            | 实例、引脚或节点不存在                                     |
| `connection/self-edge`                                   | 导线两端是同一连接端                                       |
| `net/naming-conflict`                                    | 同分量包含不同网名                                         |
| `net/reference-conflict`                                 | 同网络上存在不同理想电压                                   |

## 示例

完整文档见 [全字段 .sch JSON 示例](./examples/0024-fused-schematic.json)，包含全部根字段、实例属性、显示覆盖、属性与 HTML 视图布局、普通网标、符号内嵌网名与偏移及显式连接端；电源符号示例旋转 `90` 度，接地符号为 `0` 度，后者独立放置且尚未接线。

内存文件地址覆盖、文件集目录与项目引用的互斥示例见 [完整程序来源示例](./examples/0026-firmware-sources.json)。

示例用物理按钮与自由尺寸标注分别展示两种摆放结构：物理器件省略宽高，自由尺寸实例包含 `width` / `height`。依赖名称和摘要为占位示意；实际文件写入发布文件清单的真实摘要。

## 范围

- 包身份、发布摘要和资源由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 几何、绘制与命中由 [RFC 0022](./0022-device-2d-presentation.md) 规定。
- 侧栏视图、浮动视图交互与布局应用由 [RFC 0023](./0023-device-html-ui.md) 规定。
- 运行装配、时间推进和生命周期由 [RFC 0025](./0025-fused-runtime.md) 规定。
- 程序来源、地址覆盖、文件集与装载配置由 [RFC 0026](./0026-firmware-properties.md) 规定。

## 关联

- [RFC 0012](./0012-schematic-format.md)、[RFC 0013](./0013-canvas-format.md)：既有分离文档合同；本版通过显式连接图建立新的融合文档边界。
