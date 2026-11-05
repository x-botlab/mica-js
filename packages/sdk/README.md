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

| 命令                             | 用途                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `pnpm exec mica build`           | 生成 DDL 类型、检查元数据并构建所有组件                  |
| `pnpm exec mica prepare`         | 只生成 DDL 类型声明，不构建组件                          |
| `pnpm exec mica prepare --watch` | 启动 DDL 类型监听，适合与编辑器或 `tsc --watch` 同时使用 |
| `pnpm exec mica --help`          | 查看命令和参数；仅输入 `mica` 也会显示帮助               |

常用参数：

| 参数                 | 含义                                            |
| -------------------- | ----------------------------------------------- |
| `--root <dir>`       | 从指定目录开始查找工程，默认当前目录            |
| `--config <file>`    | 显式指定 `mica.config.ts`；相对路径基于查找起点 |
| `--source-dir <dir>` | 覆盖配置中的源码目录                            |
| `--watch`            | 监听 DDL 文件，仅用于 `prepare`                 |

```shell
pnpm exec mica build --root components
pnpm exec mica build --config mica.config.ts
pnpm exec mica prepare --source-dir content
```

默认从当前目录向上寻找最近的 `mica.config.ts`，其所在目录作为工程根目录。因此，在工程子目录中也能运行命令。`--root` 是查找起点，不一定是最终工程根目录。显式配置文件也必须命名为 `mica.config.ts`。

`prepare --watch` 只更新类型声明，不会持续构建 JS。当前 CLI 不提供开发服务器。

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

| 字段        | 默认值 | 用途                                       |
| ----------- | ------ | ------------------------------------------ |
| `sourceDir` | `src`  | 包含 `devices` 和 `widgets` 的源码目录     |
| `outDir`    | `dist` | 组件输出目录                               |
| `alias`     | 无     | 静态导入的路径别名，例如 `@/shared/colors` |
| `base`      | `/`    | 底层构建的基准路径，不配置预览服务         |

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

## 元数据

`device.json` 和 `widget.json` 由组件作者维护，用于声明显示名称、属性、端口以及器件符号等信息。SDK 检查元数据结构和目录 ID，但不会从 DDL 自动生成 JSON；器件属性、引脚和端口需要与实际实现保持一致。

器件的 `symbol` 可以定义矢量图形、引脚连接点和位号位置，示例见 [电阻模板](./templates/basic/src/devices/resistor/device.json)。Widget 的端口订阅与重绘示例见 [灯组件模板](./templates/basic/src/widgets/lamp/index.ts)。

需要自行检查元数据时，使用 `@mica-js/sdk/metadata` 的 `validateMetadata`、`deviceMetadataSchema` 或 `widgetMetadataSchema`。字节属性目前不支持在 JSON 中设置 `default`。

## 常见问题

**提示找不到 `mica` 命令。** 确认已在当前工程安装 `@mica-js/sdk`，在终端使用 `pnpm exec mica`，或通过 package scripts 调用。

**提示找不到 `mica.config.ts`。** 在工程根目录添加配置文件，或用 `--root` / `--config` 指向现有工程。Device 与 Widget 工程都需要该标志文件。

**TypeScript 无法导入 `./model.ddl`。** 先运行 `mica prepare`，确认生成了 `model.d.ddl.ts`，并启用 `allowArbitraryExtensions` 与 `moduleResolution: "Bundler"`。

**修改源码后产物没有更新。** 重新运行 `mica build`；`prepare --watch` 只处理类型声明。

## API 入口

| 入口                    | 用途                                                |
| ----------------------- | --------------------------------------------------- |
| `@mica-js/sdk/widget`   | `WidgetFactory`、绘制、输入、端口、资源与音频类型   |
| `@mica-js/sdk/device`   | 器件上下文、工厂、批次、通道与 JIT 类型             |
| `@mica-js/sdk/metadata` | Device / Widget 元数据类型、Schema 与校验           |
| `@mica-js/sdk/config`   | `defineConfig()` 与 `MicaConfig`                    |
| `@mica-js/sdk/prepare`  | 程序化类型生成和监听                                |
| `@mica-js/sdk/model`    | 器件模型 IR、Builder 与校验                         |
| `@mica-js/sdk/ddl`      | 程序化 DDL 编译与类型投影                           |
| `@mica-js/sdk`          | `createDeviceLibrary`、`createBoard` 与宿主仿真类型 |

Widget / Device 作者类型入口不会引入 Vite 或 Node 构建依赖。编写组件通常只需类型导入，实际代码由宿主通过构建产物加载。
