# @mica-js/sdk

用于开发 Mica 器件（Device）和界面组件（Widget）。SDK 提供类型定义和 `mica` CLI，将 TypeScript、DDL 与 JSON 元数据构建成宿主可加载的组件。

- **Device**：使用 DDL 描述引脚和仿真行为，按需编写 TypeScript 适配器。
- **Widget**：使用 TypeScript 绘制界面，通过端口接收和发送数据。
- **组件产物**：每个组件一份 JS 和一份 JSON，依赖与资源全部内联。

## 快速开始

建议使用 Node.js 24 和 pnpm。`mica` 命令随 `@mica-js/sdk` 安装，不需要另外安装名为 `mica` 的包，也不需要自行配置 Vite。

### 1. 安装

```shell
mkdir my-components
cd my-components
pnpm init
pnpm add -D @mica-js/sdk typescript
```

在 `package.json` 中添加以下字段，保留安装生成的依赖配置：

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "mica build",
    "prepare:types": "mica prepare",
    "typecheck": "mica prepare && tsc --noEmit"
  }
}
```

这里的 `private` 表示组件源码工程不作为 npm 包发布，不影响生成和交付组件产物。

### 2. 创建工程配置

在工程根目录创建 `mica.config.ts`：

```typescript
import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({});
```

该文件是 CLI 识别 Mica 工程的标志。空配置默认读取 `src`，输出到 `dist`。

创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowArbitraryExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "mica.config.ts"]
}
```

### 3. 编写第一个 Widget

创建 `src/widgets/lamp/widget.json`：

```json
{
  "kind": "widget",
  "id": "lamp",
  "version": "1.0.0",
  "displayName": "Lamp"
}
```

同目录创建 `index.ts`：

```typescript
import type { WidgetFactory } from '@mica-js/sdk/widget';

const create: WidgetFactory = (api) => ({
  render(ctx) {
    ctx.fillStyle = '#22aa55';
    ctx.fillRect(0, 0, api.width, api.height);
  },
});

export default create;
```

### 4. 检查并构建

```shell
pnpm run typecheck
pnpm run build
```

生成：

```text
dist/
  widgets/lamp/widget.json
  widgets/lamp/widget.js
```

将这两个文件交给支持 Mica 组件的宿主加载。CLI 负责构建，预览界面和运行环境由宿主提供；源码变更后重新运行构建。

也可以从随包提供的 [basic 模板](./templates/basic/) 开始，其中包含电阻器件和通过亮度端口更新的灯组件。安装 SDK 后，模板位于 `node_modules/@mica-js/sdk/templates/basic`；复制到自己的工程目录后，执行 `pnpm add -D @mica-js/sdk@latest typescript`，更新模板的 SDK 依赖并安装当前发布版本。

## 使用 mica CLI

在终端通过 `pnpm exec` 调用项目本地安装的 CLI；在 `package.json` 的 scripts 中可直接使用 `mica`。

| 命令                             | 用途                                                |
| -------------------------------- | --------------------------------------------------- |
| `pnpm exec mica build`           | 构建组件产物，或构建配置了 `device` 的统一器件包    |
| `pnpm exec mica build --watch`   | 持续构建统一器件包；整体替换 `outDir`，失败继续监听 |
| `pnpm exec mica pack`            | 把已有统一器件包打成 ZIP，不重新构建                |
| `pnpm exec mica prepare`         | 只生成类型环境，不构建产物                          |
| `pnpm exec mica prepare --watch` | 监听类型输入，适合与编辑器或 `tsc --watch` 同时使用 |
| `pnpm exec mica --help`          | 查看命令和参数；仅输入 `mica` 也会显示帮助          |

常用参数：

| 参数                 | 含义                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `--root <dir>`       | 从指定目录开始查找工程，默认当前目录                                          |
| `--config <file>`    | 显式指定 `mica.config.ts`；相对路径基于查找起点                               |
| `--source-dir <dir>` | 覆盖配置中的源码目录                                                          |
| `--out <file>`       | ZIP 输出路径，仅用于 `pack`；默认为 `<root>/<publisher>-<name>-<version>.zip` |
| `--watch`            | 持续构建统一器件包（`build`），或监听类型输入（`prepare`）                    |

```shell
pnpm exec mica build --root components
pnpm exec mica build --config mica.config.ts
pnpm exec mica build --watch
pnpm exec mica pack --out ./led.zip
pnpm exec mica prepare --source-dir content
```

默认从当前目录向上寻找最近的 `mica.config.ts`，其所在目录作为工程根目录。因此，在工程子目录中也能运行命令。`--root` 是查找起点，不一定是最终工程根目录。显式配置文件也必须命名为 `mica.config.ts`。

`prepare --watch` 只更新类型环境，不会持续构建 JS。持续构建统一器件包使用 `mica build --watch`；当前 CLI 不提供开发服务器。

目录直连的场景不需要 ZIP：侧载工具直接消费 `outDir`（例如 `zerobit device sideload ./dist`），配合 `mica build --watch` 就能随源码更新。手动导入或上传需要 ZIP 时再运行 `mica pack`，由 mica 按 `release.json` 生成权威归档，避免自行打包把 `release.json` 算进发布身份或产生不一致字节。

配置了 `device` 的工程按[统一器件包](#统一器件包device-模式)构建；其余工程仍按下面的组件流程构建，两种模式的命令和参数完全相同。

## 电路测试工程

电路测试由独立的 `@mica-js/testing` 提供 `mitest` CLI、`mitest.config.ts` 和 `.mitest/` 类型化入口。测试工程只需依赖 testing；器件作者继续使用 `mica build` 交付包含 `release.json` 的器件包。

类型化位号、依赖锁、准备命令与 Vitest 示例见 [testing 工作流](../testing/README.md#类型化测试工程)。

## 工程目录

一个工程可以同时包含多个 Device 和 Widget：

```text
my-components/
  mica.config.ts
  package.json
  tsconfig.json
  src/
    devices/
      resistor/
        device.json
        model.ddl
        index.ts          # 可选的宿主适配器
    widgets/
      lamp/
        widget.json
        index.ts
    shared/               # 组件共享的源码或内联资源
```

组件目录名必须与元数据 `id` 相同，只使用字母、数字和中划线。各组件的 `id` 和 `version` 在自己的 JSON 中维护，与工程 `package.json` 的名称和版本分开。

`shared` 不是组件入口；组件可以通过普通静态导入复用其中的代码。构建时，共享代码会分别打包进每个使用它的组件，不生成共享 chunk。

## 添加 Device

创建 `src/devices/resistor/device.json`：

```json
{
  "kind": "device",
  "id": "resistor",
  "version": "1.0.0",
  "displayName": "Resistor",
  "designatorPrefix": "R",
  "properties": {
    "resistance": {
      "type": "number",
      "required": false,
      "default": 1000,
      "unit": "ohm"
    }
  },
  "pins": { "a": {}, "b": {} }
}
```

同目录创建 `model.ddl`：

```text
device Resistor(resistance: number default 1000) {
  pin a = [resistor(to: b, resistance: resistance)];
  pin b;
}
```

纯 DDL 器件不需要 `index.ts`，SDK 会生成最小同步工厂。需要与宿主交换输入、输出或资源时，再添加适配器：

```typescript
import type { Factory } from './model.ddl';

const create: Factory = () => ({
  sync(batch) {},
  dispose() {},
});

export default create;
```

工厂和适配器钩子必须同步返回。使用生成的 `Factory` 类型可以获得与 DDL 对应的上下文、属性、输入和批次输出类型。

### DDL 类型声明

首次编写适配器或修改 DDL 后，运行：

```shell
pnpm exec mica prepare
```

命令会在 `model.ddl` 旁生成 `model.d.ddl.ts`。开发时可单独运行 `pnpm exec mica prepare --watch` 保持声明更新。`mica build` 也会生成声明；单独运行 `tsc` 前则需要先执行 `mica prepare`。

使用 `import type` 引用 DDL 类型，不要把 DDL 文件作为运行时 JS 模块导入。在 `.gitignore` 中忽略构建产物和生成的声明：

```gitignore
dist/
node_modules/
**/*.d.ddl.ts
```

## 项目配置

```typescript
import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({
  sourceDir: 'src',
  outDir: 'dist',
  alias: { '@': './src' },
});
```

| 字段        | 默认值 | 用途                                                   |
| ----------- | ------ | ------------------------------------------------------ |
| `sourceDir` | `src`  | 包含 `devices` 和 `widgets` 的源码目录                 |
| `outDir`    | `dist` | 组件输出目录                                           |
| `alias`     | 无     | 静态导入的路径别名，例如 `@/shared/colors`             |
| `base`      | `/`    | 底层构建的基准路径，不配置预览服务                     |
| `device`    | 无     | 统一器件包配置；见[统一器件包](#统一器件包device-模式) |

源码、输出和别名路径都相对于工程根目录解析。输出目录不能是工程根目录或其上级目录，也不能与源码目录互相包含，以免构建清理覆盖源码。

`alias` 用于构建时解析导入。若 TypeScript 源码也使用别名，需要在 `tsconfig.json` 的 `compilerOptions.paths` 中配置对应映射。

Vite 已由 SDK 管理，不需要额外安装 Vite 或创建 `vite.config.ts`。配置文件是可执行 TypeScript，只应加载受信任的工程配置。

## 产物与资源

运行 `mica build` 后，每个组件生成一对文件：

```text
dist/
  devices/resistor/device.json
  devices/resistor/device.js
  widgets/lamp/widget.json
  widgets/lamp/widget.js
```

- Device JS 具名导出 `model` 和同步 `create` 工厂；Widget JS 默认导出同步工厂。
- 每份 JS 都是独立的 ESM，依赖在构建时打包，产物不保留外部模块导入、`import()` 或 `import.meta`。
- 资源必须内联。文本可以使用 `?raw` 导入，标准 `?url` 资源导入在库构建中内联。
- 构建结果仅包含 JS 和 JSON。会产生独立 CSS 或其他资源文件的入口会构建失败。

组件产物不是 npm 包；将文件交付给宿主的组件库或静态资源服务即可，模块加载和执行隔离由宿主负责。

## 统一器件包（device 模式）

在 `mica.config.ts` 中增加 `device` 字段，工程就从“多组件源码”变成“一个器件包”：

```typescript
import { defineConfig } from '@mica-js/sdk/config';

export default defineConfig({
  device: { manifest: './package.json', model: './src/model.ddl' },
});
```

| 字段              | 必填 | 用途                                                        |
| ----------------- | ---- | ----------------------------------------------------------- |
| `device.manifest` | 是   | 器件清单路径，相对工程根目录；通常就是工程的 `package.json` |
| `device.model`    | 否   | DDL 模型源文件路径，相对工程根目录                          |

`sourceDir` 在 `device` 模式下表示**包根目录**：清单里的每个产物路径 `p` 对应源码 `<sourceDir>/p`。产物路径必须是包根相对的 POSIX 路径，不能包含 `\`、驱动器、绝对路径或 `.`/`..` 段。

`.js`、`.mjs`、`.jsx` 产物路径同时接受对应的 TypeScript 源码，按以下顺序取第一个存在的文件：声明的路径、`.ts`、`.tsx`、`.mts`（`.mjs` → `.mts`，`.jsx` → `.tsx`）。因此 `model.entry: "model.js"` 可以由 `src/model.ts` 实现。

### 入口与产物规则

| 清单声明                | 源码                                           | 产物                                                   |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `model.entry`           | 声明 DDL 时由 SDK 生成入口；工厂来自同路径源码 | 自包含 ESM，具名导出 `model`（编译后的 IR）与 `create` |
| `view2d.entry`          | 同路径的 TS/JS 模块                            | 自包含 ESM，默认导出 `View2DFactory`                   |
| `entries.view3d`        | 同路径的 TS/JS 模块                            | 自包含 ESM                                             |
| `view2d.geometry`       | 同路径 JSON                                    | 原样复制，并由 `parseGeometry2D` 按当前引脚集合校验    |
| `view.*.entry`          | 同路径 HTML                                    | 原样复制，同时发布其相对引用                           |
| `icon`、`bodyImage`     | 同路径图片                                     | 原样复制                                               |
| 属性的 `package` 默认值 | 同路径资源                                     | 原样复制                                               |
| `assets/**`             | `<sourceDir>/assets` 下的全部文件              | 原样复制，供编辑器的内置资源选择器列举                 |
| 根 `package.json`       | `device.manifest` 指向的清单                   | 原样写出为包清单                                       |

- 声明 DDL 时，`model.entry` 由 SDK 生成：IR 写入模块，`create` 从同路径源码重新导出。该路径没有源码时，只有在清单未声明方法与事件的情况下才生成最小同步工厂；否则准备阶段报错，要求提供实现模块。
- 不声明 DDL 时，`model.entry` 的源码必须自行具名导出 `model` 与 `create`。
- 每个 JS 入口都是一个自包含 ESM：依赖在构建时打包，产物不含模块导入、`import()`、`import.meta` 或 Node 内建模块。
- HTML 按原样复制，并递归发布其相对引用：`src`/`href` 指向的脚本模块按入口规则打包，其他文件复制；样式表继续跟踪 `url()` 与 `@import`。外部 URL、`data:`、`#` 引用保持原样；绝对路径或解析后超出包根的引用直接报错。
- `assets/` 之外的资源只要被清单或 HTML 引用就会发布，其余文件不进入包。

### 类型环境

`mica prepare` 在工程根目录生成 `.mica/device.d.ts` 与 `.mica/tsconfig.json`，`.mica` 由 SDK 维护，建议加入 `.gitignore`。作者工程通过继承获得全局类型：

```json
{
  "extends": "./.mica/tsconfig.json"
}
```

需要脱离 CLI 复用同一套构建时，使用 `@mica-js/sdk/device-build`：

```typescript
import { buildDevice } from '@mica-js/sdk/device-build';

const result = await buildDevice({
  root: process.cwd(),
  manifest: './package.json',
  model: './src/model.ddl',
  outDir: 'dist',
});
```

`buildDevice()` 依次完成准备、打包和写出，返回写出的包内文件绝对路径；参数与 `device` 配置字段一一对应，`sourceDir` 默认 `src`，`alias` 相对 `root` 解析。

生成配置以 `files: ["./device.d.ts"]` 固定加载声明，`include: ["../<sourceDir>"]` 选择源码；作者可以覆盖 `include` 追加目录，只要保留生成声明即可。`device.d.ts` 提供固定全局名（器件名不进入类型名）：

| 类型                 | 内容                                                     |
| -------------------- | -------------------------------------------------------- |
| `DeviceProps`        | 全部清单属性的只读值类型，含默认值补全与 `nullable` 投影 |
| `DeviceMethods`      | 清单方法的同步实现签名                                   |
| `DeviceEvents`       | 事件名到载荷类型的映射                                   |
| `DeviceModelContext` | 核心上下文、完整属性快照与按事件名生成的 `fire` 出口     |
| `DeviceFactory`      | 同步模型工厂，约束方法实现、`sync` 批次与释放钩子        |
| `DeviceClient`       | 异步方法代理与 `Event<ModelEvent<T>>` 订阅               |
| `DevicePinId`        | 清单引脚 ID 的字面量联合；无引脚时为 `never`             |

- 属性类型投影：`integer`/`number` → `number`，`color` → `string`，枚举 → 选项值字面量联合，`image`/`binary` → `ReadonlyBytes`，`firmware` → `FirmwareImage`，`nullable: true` 追加 `| null`。
- 输入通道、内存与输出批次类型来自 DDL 编译结果；没有 DDL 时使用 `Record<never, never>`。
- 声明文件的生成只读取清单、编译 DDL 并渲染类型，不执行任何作者模块。

生成的类型通过 `@mica-js/sdk/device` 提供，作者源码直接使用全局类型名；该入口只暴露 RFC 0021 的作者类型与 RFC 0026 的 `FirmwareImage` / `FirmwareSegment`；运行时实现（`createHeadlessRuntime`、`prepareFusedSession`、包打开、固件解码）与宿主准备类型只在 `@mica-js/sdk/fused`，`MethodError` 的类值也从此处导入（`device` 入口只提供其类型）。

### 校验与失败行为

`mica build` 先执行与 `prepare` 相同的准备流程，准备失败则构建停止，不写出任何产物。`mica prepare --watch` 监听清单、DDL 与 `mica.config.ts`，串行重新生成；失败时报告错误并继续监听，上一次成功的类型文件保持不动。输入内容不变时不重写输出。

`mica build --watch` 先完整构建一次，随后监听 `sourceDir`（递归）、清单、DDL 与 `mica.config.ts`；变化经防抖后串行重建。配置或 `sourceDir` 改动会重新加载配置并重定向监听。每次成功构建输出一行 `mica build: complete <id>@<version> <integrity>`；失败只写 stderr，保留上一份完整产物并继续监听，初始构建失败也不退出。按 Ctrl+C 时等待当前构建结束后退出。

准备阶段额外校验 DDL 与清单的一致性，全部通过才生成类型：

- 引脚集合必须相等。
- DDL 声明的每个属性都必须在清单中描述，类型需相互对应（`number` ↔ `number`/`integer`、`string` ↔ `string`/`color`、`bool` ↔ `boolean`、`bytes` ↔ `binary`/`image`、枚举 ↔ 选项集合），可空性与默认值存在性必须一致；DDL 默认值必须能静态求值（字面量、`const` 引用、纯算术/字符串/比较运算、纯数值内建函数、记录与字节构造），求值结果还必须与清单一致。无法静态求值的默认值在准备阶段直接失败，而不是跳过比较。
- `firmware` 等组合属性不能由 DDL 声明。
- `view2d.geometry` 必须通过 `parseGeometry2D` 校验，包括与引脚集合的一致性。

### 产物与发布清单

`mica build` 清空 `outDir` 后写入包内文件，并生成 `release.json`。`mica build --watch` 先在临时目录完成构建，再整体替换 `outDir`，因此监听 `outDir` 的消费者不会读到半成品；任何失败都保留上一份完整产物：

```text
dist/
  package.json
  model.js
  views/index.html
  views/2d/geometry.json
  views/2d/index.js
  assets/...
  release.json
```

`release.json` 记录 `id`（`publisher:name`）、`version` 与每个包内文件的 `size`、`integrity`（`sha256:` 加 64 位小写十六进制）。它自身与 ZIP 不属于 `files`，避免自引用。同一路径若被两个来源声明，构建直接报错而不是静默覆盖。

`outDir` 在删除前校验：它不能是文件系统根目录、主目录或其上级目录，也不能等于或包含工程根、`sourceDir`、清单文件、DDL 源文件或 `.mica`。`buildDevice()` 在准备前和写出前各校验一次，因此任何校验失败都不会删除已有内容。

### 打包已有产物

`mica pack` 不构建，只把 `outDir` 里已有的统一器件包打成 ZIP。归档内容严格等于 `release.json` 的 `files` 表加上根目录的 `release.json`：`release.json` 描述发布身份，本身不计入该身份。条目按包根相对路径排序并以 store-only（`level: 0`）写入，时间戳固定，因此同一份产物重复打包字节完全一致。

任一文件与 `release.json` 记录的大小或 `sha256` 不符、文件缺失，或 `outDir` 没有 `release.json` 时，命令直接失败且不写出 ZIP。默认输出到工程根目录的 `<publisher>-<name>-<version>.zip`，可用 `--out` 改路径；成功时输出一行 `mica pack: <绝对路径>`。

## 统一器件无头运行

`@mica-js/sdk/fused` 的 `createHeadlessRuntime({ document, registry, loadModule, step })` 使用正式电气求解器运行 `.sch v2`。`registry` 提供锁定包的文件表与字节；准备阶段校验身份、文件摘要、清单、拓扑及模型 IR 后，才创建模型。`loadModule` 接收已校验的包读取接口与模型入口路径，返回该模块的导出。

创建完成时运行时暂停在零时刻。`getModel(instanceId)` 返回该实例的方法与事件代理；`step()` 推进一个正整数皮秒步长，`resume()` 持续推进，`pause()` 暂停。初始化事件可由创建参数 `onModelEvent` 捕获。查询响应先于后续方法产生的事件交付，异步事件回调不阻塞仿真。

`reset()` 沿用本次准备的包与资源快照重建模型，旧代理以 `model/disconnected` 拒绝调用，也可用于模型故障后的恢复。`dispose()` 释放会话；复位或释放中的清理失败会明确拒绝。调用方应在 `finally` 中等待释放。

当前入口在宿主进程内运行，模块执行环境由 `loadModule` 的实现提供。资源字节与模型值采用独立快照；固件支持 BIN，HEX/ELF 会以 `firmware/unsupported-format` 明确拒绝。ZIP 归档、图像像素限制校验与编辑器隔离集成在后续阶段完成。

器件测试可使用独立的 [@mica-js/testing](../testing/README.md)，复用同一运行时，并提供虚拟时间推进、初始化事件记录及复位控制。

## 元数据

`device.json` 和 `widget.json` 由组件作者维护，用于声明显示名称、属性、端口以及器件符号等信息。SDK 检查元数据结构和目录 ID，但不会从 DDL 自动生成 JSON；器件属性、引脚和端口需要与实际实现保持一致。

器件的 `symbol` 可以定义矢量图形、引脚连接点和位号位置，示例见 [电阻模板](./templates/basic/src/devices/resistor/device.json)。Widget 的端口订阅与重绘示例见 [灯组件模板](./templates/basic/src/widgets/lamp/index.ts)。

需要自行检查元数据时，使用 `@mica-js/sdk/metadata` 的 `validateMetadata`、`deviceMetadataSchema` 或 `widgetMetadataSchema`。字节属性目前不支持在 JSON 中设置 `default`。

## 常见问题

**提示找不到 `mica` 命令。** 确认已在当前工程安装 `@mica-js/sdk`，在终端使用 `pnpm exec mica`，或通过 package scripts 调用。

**提示找不到 `mica.config.ts`。** 在工程根目录添加配置文件，或用 `--root` / `--config` 指向现有工程。Device 与 Widget 工程都需要该标志文件。

**TypeScript 无法导入 `./model.ddl`。** 先运行 `mica prepare`，确认生成了 `model.d.ddl.ts`，并启用 `allowArbitraryExtensions` 与 `moduleResolution: "Bundler"`。

**修改源码后产物没有更新。** 重新运行 `mica build`，或使用 `mica build --watch` 自动重建；`prepare --watch` 只处理类型声明。

## API 入口

| 入口                        | 用途                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `@mica-js/sdk/widget`       | `WidgetFactory`、绘制、输入、端口、资源与音频类型                                         |
| `@mica-js/sdk/fused`        | 统一器件模型、展示、包与无头运行时的运行时合同                                            |
| `@mica-js/sdk/fused/node`   | Node 本地器件包读取与目录 registry：`readDirectoryPackage()`、`createDirectoryRegistry()` |
| `@mica-js/sdk/device-build` | 程序化构建统一器件包：`buildDevice()`                                                     |
| `@mica-js/sdk/device`       | 器件上下文、工厂、批次、通道与 JIT 类型                                                   |
| `@mica-js/sdk/metadata`     | Device / Widget 元数据类型、Schema 与校验                                                 |
| `@mica-js/sdk/config`       | `defineConfig()` 与 `MicaConfig`                                                          |
| `@mica-js/sdk/prepare`      | 程序化类型生成和监听                                                                      |
| `@mica-js/sdk/model`        | 器件模型 IR、Builder 与校验                                                               |
| `@mica-js/sdk/ddl`          | 程序化 DDL 编译与类型投影                                                                 |
| `@mica-js/sdk`              | `createDeviceLibrary`、`createBoard` 与宿主仿真类型                                       |

Widget / Device 作者类型入口不会引入 Vite 或 Node 构建依赖。编写组件通常只需类型导入，实际代码由宿主通过构建产物加载。
