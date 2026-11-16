# 器件 HTML 视图

- Start Date: 2026-11-15
- Reference Issues: —（尚未实现）
- Implementation PR: —（尚未实现）

规定器件附加 HTML 视图的声明、编辑器内置容器、环境资源配置、隔离桥接和运行生命周期。本文中的宿主指融合编辑器内部的视图环境管理能力；视图直接使用所属模型接口，与 2D 或 3D 场景绘制解耦。本合同为待实现草案。MUST / MUST NOT 为强制要求，SHOULD 为推荐，MAY 为可选。

## 声明

### 视图入口与身份

| 字段                     | 类型   | 必填 | 约束                                   |
| ------------------------ | ------ | ---- | -------------------------------------- |
| `view`                   | object | 否   | 缺省空，视图 ID 到条目的映射           |
| `view.*.title`           | string | 是   | 非空视图标题                           |
| `view.*.entry`           | string | 是   | 锁定包内的 HTML 文件路径               |
| `view.*.defaultLocation` | enum   | 否   | `sidebar` / `floating`，缺省 `sidebar` |
| `view.*.icon`            | string | 否   | Codicons 图标名，由编辑器提供图标资源  |

- 视图实例键为所属运行会话内的 `(器件实例 ID, 视图 ID)`；容器位置为 `sidebar` / `floating`。
- 同一器件可提供多个具名视图；侧栏和浮动面板使用同一个 HTML 入口，单视图路径示例为 `views/index.html`，多视图可用 `views/serial/index.html` 等独立目录。
- 同一视图实例键最多对应一个活动 HTML 环境；重复打开只聚焦已有实例。
- 属性 View 与 HTML Views 的顺序、折叠、高度和停靠位置按器件实例的 `viewLayout` 保存到文档，相同器件类型的不同实例独立恢复，结构见 [RFC 0024](./0024-fused-schematic-format.md)；页面存活、焦点和端口属于会话状态。
- HTML 视图不替代场景展示能力，也不提供电气引脚锚点。
- 包中省略 `view` 时，宿主不呈现该器件的 HTML 视图打开操作。

### 编辑器创建配置

| 字段                  | 类型   | 必填 | 约束                                                          |
| --------------------- | ------ | ---- | ------------------------------------------------------------- |
| `viewBaseUrlTemplate` | string | 是   | 创建融合编辑器时提供的 HTML 环境资源目录 URL 模板，末尾为 `/` |

- 模板为绝对 HTTP(S) URL，部署满足浏览器安全上下文要求；主机名包含一个完整标签 `${id}`，由编辑器替换为环境标识。
- 环境标识由编辑器生成，符合 DNS 标签规则；每个新 HTML 环境使用不同标识与独立源，侧栏与浮动面板之间切换保留原环境。
- 接入方在模板对应的主机名和目录部署同版本编辑器随附的 HTML 环境静态资源；模板中的版本路径由接入方固定。
- 编辑器内部完成环境创建、资源代理、桥接、容器与清理；创建配置属于接入应用配置，不写入器件清单或电路文档。
- 模板在创建编辑器时校验；打开视图时才加载环境资源，加载失败明确报告视图故障。

### 作者侧桥接

下列 `Value`、`Methods`、`ModelClient` 和 `Event` 见 [RFC 0021](./0021-device-model-api.md)。

```ts
interface HtmlAssets {
  read(path: string): Promise<Uint8Array>;
  getUrl(path: string): Promise<string>;
}
interface DeviceViewApi<P, M extends Methods, E extends Readonly<Record<string, Value>>> {
  readonly props: Readonly<P>;
  readonly model: ModelClient<M, E> | undefined;
  readonly assets: HtmlAssets;
  readonly onDidClose: Event<void>;
}
declare function acquireDeviceViewApi<
  P,
  M extends Methods,
  E extends Readonly<Record<string, Value>>,
>(): Promise<DeviceViewApi<P, M, E>>;
```

- HTML 在隔离的 DOM 环境使用 HTML、CSS 和包内脚本；宿主提供一次性的 `acquireDeviceViewApi` 桥接入口。
- 同一环境多次获取返回同一 API，握手只执行一次；HTML 业务代码不能创建额外模型实例。
- API 取得前业务代码等待初始化；取得后获得绑定到所属模型生命周期的代理。
- 无模型器件的 `model` 为 `undefined`，视图仍可显示属性与静态说明。
- 方法和事件的业务合同与场景展示完全相同；SDK 使用相同清单生成类型。
- HTML MUST NOT 导入模型实现或借场景 JS 转发业务通信；模型不获得视图身份和连接信息。
- `read` 与 `getUrl` 接收包根相对路径；`getUrl` 返回仅在当前视图环境有效的不透明资源 URL，关闭后由宿主撤销。
- `onDidClose` 用于局部资源清理。

## 运行时

### 容器行为

- 编辑器内置视图打开、聚焦、停靠与关闭操作，统一管理侧栏和浮动面板。
- 侧栏直接从固定在顶部的属性 View 开始；位号和器件身份显示在属性内容中，不另设容器总标题或身份标题行。
- HTML Views 位于属性 View 下方，各有标题栏；支持折叠、拖动标题栏排序、拖动分隔条调整高度。
- HTML 视图只在运行模式开放，暂停状态仍可打开、查询和调用方法；编辑态显示属性和视图说明，不创建 HTML 环境。
- 运行模式进入或当前单选器件变化时，恢复该实例的有效布局，自动加载已展开的侧栏 HTML Views；多选或清除选择时不挂载器件侧栏 HTML 视图。
- 初始侧栏视图展开，高度由编辑器按可用空间分配；保存的实例布局优先于默认位置、顺序、高度与折叠状态。
- 折叠视图首次展开时才加载 HTML；已加载的视图折叠时保留页面、监听与局部状态。
- 切换到另一器件或结束单选时释放原器件的侧栏页面；浮动面板固定关联原器件，不跟随选择。
- 属性 View 标题栏右侧显示归属 `floating` 的视图图标，属性折叠后仍可操作；视图未打开时点击打开，已打开时点击聚焦并标记打开状态。
- 图标按钮使用视图标题作为悬停提示，可访问名称包含所属器件与视图标题；空间不足的入口收进更多菜单，排列遵循实例视图顺序。
- 侧栏 HTML View 标题栏提供浮动按钮；切换后视图退出侧栏，其入口出现在属性标题栏。
- 浮动窗口标题显示所属器件与视图标题，并提供停靠侧栏和关闭按钮；停靠时恢复原侧栏顺序并展开，若所属器件未选中则先选中它。
- 停靠成功后属性标题栏移除对应浮动入口；同一视图的业务内容在一个位置显示。
- 侧栏与浮动面板之间切换保留同一个活动 HTML 环境、JS 内部状态、模型代理和监听，不产生第二个视图实例。
- 首版浮动容器是编辑器内部可移动、调整尺寸、关闭和停靠的面板。
- 关闭浮动视图释放其通道、监听和资源，保留浮动布局归属及最近矩形，模型继续保持当前运行状态。
- 首次浮动由编辑器居中安排；恢复矩形按当前可用区域约束，避免窗口不可见，适配本身不自动改写已保存布局。
- 重新打开文档只恢复布局；运行中选中器件时恢复侧栏，浮动视图通过属性标题栏入口显式打开。
- 恢复默认布局移除该实例的布局覆盖，重新采用清单初值；已打开视图按有效布局调整容器，回到折叠区的页面保留。
- 布局撤销、重做同样调整已打开视图；未打开视图恢复为浮动归属时仅恢复入口，侧栏归属则按展开状态自动加载。
- 退出运行释放全部 HTML 视图；复位保留容器位置，重建视图并绑定新模型后重新初始化。
- 无头执行保持无 HTML 视图环境；HTML 视图能力本身不改变器件模型是否可无头执行。

### 运行中打开与监听

1. 编辑器按创建配置准备独立 HTML 环境与受控资源访问，再加载器件 HTML 及其资源并建立桥接。
2. 视图取得 API，先注册需要的状态事件，再调用模型方法查询完整当前状态。
3. 依照 [RFC 0021](./0021-device-model-api.md) 的交付顺序同步应用查询结果和状态事件；需要初态的用户交互在查询成功后开放。
4. 活动监听从激活时接收事件，查询等待期间照常派发；视图自行安排批量读取、局部缓冲与绘制。

- 模型可以在 HTML 加载和绘制期间继续推进；监听注册与查询分别在各自的安全边界处理。
- 初始查询之前的串口记录等历史数据由模型业务缓冲及查询方法提供，查询与实时事件的重叠记录按业务游标去重。
- 多个 HTML 视图和场景独立监听同一事件；关闭一个视图只移除它自己的监听。
- 视图的异步业务处理与 DOM 绘制独立于模型推进。
- 回调同步抛错或返回的 Promise 拒绝时明确标记视图故障，按 [RFC 0025](./0025-fused-runtime.md) 的故障规则释放资源。

### 隔离与通信

- 宿主为每个 HTML 视图授予限定所属模型生命周期与页面环境的桥接能力，拒绝越权实例调用与已失效环境的消息。
- 桥接端口使用 `createRpc(port)`；服务用 `defineRpcService` 声明的 `RpcServiceId<T>` 注册和取代理，wire 服务键保持可序列化字符串。
- 事件使用现有 `onDidXxx` 订阅机制，二进制所有权通过 transfer hooks 实现。
- HTML 的宿主桥使用隔离容器的控制通道完成单次端口握手；此后业务数据经所授予端口传递。
- 端口握手绑定目标页面、一次性校验值和当前模型生命周期；拒绝来自其他页面或旧页面的握手消息。
- HTML 环境具有独立源与受控资源策略；编辑器 DOM、宿主文件系统和凭据不作为页面全局能力开放。
- HTML、CSS 和 JS 模块的相对资源按引用文件所在目录解析；规范化结果保持在当前包内，读取经过锁定资源映射及摘要验证。
- 宿主文件系统通过已有 typed RPC 资源服务提供，HTML 作者使用 `assets` 而非原始文件系统代理。
- 导航离开获准包资源范围视为视图关闭；旧页面端口立即失效。
- HTML 代码通过普通 DOM 事件处理按下、松开、取消和失焦，并直接调用所属模型方法。
- 参数修改通过运行模型方法表达，HTML 不绕过文档写入与运行只读属性规则。

## 校验

| 诊断码                           | 条件                                      |
| -------------------------------- | ----------------------------------------- |
| `view/invalid-base-url-template` | 创建配置中的 URL 模板非法，编辑器创建失败 |
| `view/unknown-entry`             | 请求未声明的视图 ID                       |
| `view/unavailable-mode`          | 在编辑态或无头模式请求容器                |
| `view/load-failed`               | HTML、脚本或包资源加载失败                |
| `view/bridge-failed`             | 握手失败、越权或端口失效                  |
| `view/execution-failed`          | 初始化或业务回调异常                      |

- 同名视图重复打开是聚焦操作，不报重复实例错误。
- 视图故障必须显示所属器件、视图标题与原因；模型及其他展示继续执行。
- 故障视图终止业务监听与输入并释放资源；重开是用户显式操作。

## 示例

创建配置中 HTML 环境资源字段的完整示例；`${id}` 保留为编辑器替换的占位符，路径中的提交摘要已由接入方固定：

```json
{
  "viewBaseUrlTemplate": "https://${id}.cdn.example.com/path/to/public/0123456789abcdef0123456789abcdef01234567/__mica_view__/"
}
```

清单片段：

```json
{
  "view": {
    "serial": {
      "title": "串口终端",
      "entry": "views/serial/index.html",
      "defaultLocation": "floating",
      "icon": "terminal"
    },
    "registers": {
      "title": "寄存器",
      "entry": "views/registers/index.html",
      "defaultLocation": "sidebar",
      "icon": "list-tree"
    }
  }
}
```

侧栏示意；图标由编辑器使用 Codicons 绘制，属性内容内展示元件身份：

```text
┌─────────────────────────────────┐
│ ▾ 属性             [串口] [⋯]   │
│ 位号       U1                   │
│ 器件       89C52                 │
│ 时钟频率   12 MHz               │
├───────── 可拖动分隔条 ───────────┤
│ ▾ 寄存器               [↗] [⋯] │
│ ACC  0x00      SP   0x07         │
├───────── 可拖动分隔条 ───────────┤
│ ▸ I/O 状态             [↗] [⋯] │
└─────────────────────────────────┘
```

视图初始化片段，使用所属模型的状态查询方法和事件：

```js
const api = await acquireDeviceViewApi();
if (!api.model) throw new Error('This view requires a model');
const output = document.querySelector('output');
if (!output) throw new Error('Missing output element');
const render = (value) => {
  output.textContent = String(value);
};
const subscription = api.model.events.onDidBrightnessChange(({ value }) => render(value));
api.onDidClose(() => subscription.dispose());
render(await api.model.methods.getBrightness(null));
```

## 范围

- 包资源和 HTML 视图条目定位由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 公共方法、事件与查询交付顺序由 [RFC 0021](./0021-device-model-api.md) 规定。
- 实例布局持久化、校验和文档命令由 [RFC 0024](./0024-fused-schematic-format.md) 规定。
- 运行生命周期和故障由 [RFC 0025](./0025-fused-runtime.md) 规定。

## 关联

- [RFC 0022](./0022-device-2d-presentation.md)：与 HTML 视图共享模型但独立渲染的 2D 展示。
