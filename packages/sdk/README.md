# @mica-js/sdk

Device / Widget 作者 API、DDL 类型准备及 CLI 双文件构建。每个条目独立发布；一个工程可以维护多个条目。Vite 由 SDK 内部管理，作者使用 `mica build` 与 `mica prepare`。

## 工程与产物

源码使用固定入口：

```text
src/
  devices/<id>/
    device.json
    model.ddl
    index.ts            # 可选，省略时生成最小同步工厂
  widgets/<id>/
    widget.json
    index.ts
  shared/
```

构建结果只有以下文件，不生成归档、包清单或独立资源：

```text
dist/
  devices/<id>/device.json
  devices/<id>/device.js
  widgets/<id>/widget.json
  widgets/<id>/widget.js
```

目录名与元数据 `id` 一致，字符范围为字母、数字、中划线。身份与版本由条目 JSON 的 `id`、`version` 表达。Device JS 具名导出 `model`（共享 DeviceIR）与 `create`（同步适配器工厂）；Widget JS 默认导出同步实例工厂。每个 JS 独立打包依赖，宿主不解析 npm 导入或共享 chunk。模块装载及执行隔离由宿主负责。

## 项目配置与命令

工程根目录必须包含 `mica.config.ts`，空配置使用全部默认约定：

```typescript
import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({});
```

CLI 从当前目录向上查找最近的 `mica.config.ts`，该文件所在目录就是项目根目录；`--root` 改变查找起点，`--config` 指定配置文件（相对于查找起点）。未找到配置时报告错误。IDE 可以仅通过文件是否存在识别项目；配置是可执行 TypeScript，只应在受信任的工程中加载。

可选配置示例：

```typescript
export default defineConfig({
  sourceDir: 'src',
  outDir: 'dist',
  base: '/components/',
  alias: { '@': './src' },
});
```

源码、输出及别名路径相对于项目根目录解析；输出目录必须与源码目录分离，避免构建清理覆盖源码。配置只接受 SDK 定义的字段，Vite 是内部构建引擎；作者不需要安装 Vite 或维护 `vite.config.ts`。

```shell
mica build
mica prepare
mica prepare --watch
mica build --config ./mica.config.ts
```

`mica build` 准备 DDL 类型、校验元数据并独立打包每个条目，将双文件产物写入 `outDir`。预览宿主自行提供这些静态产物；组件源码变更后重新运行构建。

内部打包复用 Vite 的 TS 与资源转换及别名解析。`?raw` 资源成为字符串，`?url` 等标准资源导入在库构建中内联。样式表等会额外输出文件的入口会构建失败；运行期模块导入、`import.meta` 引用同样拒绝。资源如何解码和使用由实现与宿主允许的 API 决定。

## DDL 类型

```typescript
import type { Factory } from './model.ddl';

const create: Factory = (ctx) => ({
  sync(batch) {
    // ctx.props、ctx.inputs、ctx.memory 和 batch.outputs 按该 DDL 精确投影。
  },
  dispose() {},
});

export default create;
```

TypeScript 配置需要 `allowArbitraryExtensions: true`、`moduleResolution: "Bundler"`（或其他支持该扩展声明的解析模式）。`mica prepare` 在每份 DDL 旁生成 `model.d.ddl.ts`，提供 `Props`、`PropertyInput`、`Inputs`、`Memory`、`Outputs`、`Context`、`Batch`、`Adapter`、`Factory` 别名。声明仅供编译期使用；`import type` 不产生 DDL 运行时导入。建议忽略 `**/*.d.ddl.ts`。

```shell
mica prepare
mica prepare --watch
mica prepare --root . --source-dir src
```

`mica build` 也运行类型准备。独立 `tsc` 前仍应先运行 `mica prepare`。失败时只清理带 SDK 生成标记的过期声明；作者维护的文件受到保护。所有工厂与适配器钩子遵循新版仿真规范的同步返回、数据所有权和实例生命周期合同。

## JSON 元数据

JSON 由作者完整维护，构建器只校验 JSON 自身结构以及 ID 与目录名；不从 DDL 提取属性或引脚，不做 JSON 与 DDL 的一致性检查，也不向发布 JSON 注入默认值。元数据的格式化可能改变空白。

`@mica-js/sdk/metadata` 导出 `deviceMetadataSchema`、`widgetMetadataSchema`、`validateMetadata` 以及相应 TypeScript 类型。元数据不含 `formatVersion`、`icon`、`category`。字节属性的 JSON 默认编码尚未定义，因此 `bytes` 属性暂不接受 JSON `default`。

`symbol` 描述静态矢量符号、引脚连接点和位号位置。X 向右、Y 向下，角度单位为度，正扫角顺时针。使用逻辑单位，建议 10 单位为默认网格间距；颜色使用主题角色。JSON 校验不证明符号引脚或属性与 DDL 一致。

## 公开入口

| 入口                    | 内容                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `@mica-js/sdk`          | `createDeviceLibrary`、`createBoard`、`SimulationError` 及宿主类型 |
| `@mica-js/sdk/device`   | 器件上下文、工厂、批次、通道、话题与 JIT 类型                      |
| `@mica-js/sdk/widget`   | Widget 工厂、上下文、绘制、输入、资源与音频类型                    |
| `@mica-js/sdk/model`    | 共享 IR、Builder 与校验                                            |
| `@mica-js/sdk/ddl`      | DDL 编译与类型投影                                                 |
| `@mica-js/sdk/metadata` | Device / Widget Schema、类型与校验                                 |
| `@mica-js/sdk/config`   | `defineConfig()`、`MicaConfig` 及项目配置发现与加载                |
| `@mica-js/sdk/prepare`  | `prepare()`、声明监听工具                                          |

浏览器作者入口不会引入 Vite 或 Node 构建依赖。最小工程见 [templates/basic](./templates/basic/)，使用前将其作为独立工程安装依赖。
