# @mica-js/device

器件层入口：解析已加载的器件描述、通过宿主 `IDeviceProvider` 加载同步 JS 工厂，并为每个实例提供独立、递归只读的属性快照。

本包负责**描述对象解析、#10 端口校验、#7 属性默认值/值校验、JS 工厂导出形式校验与属性快照**。不负责文件定位、文件读取、缺失文件诊断或 JSON 语法解析；这些由宿主 `IDeviceProvider` 实现。工厂上下文、生命周期、消息桥接、引脚 I/O、观察与连接分别留给 #53–#57。

## 安装

```bash
pnpm add @mica-js/device
```

## 公共入口

唯一公开入口为 `@mica-js/device`，构建生成 `dist/index.js`（ESM）与声明文件。

| 导出                        | 作用                                                          |
| --------------------------- | ------------------------------------------------------------- |
| `parseDeviceDescription()`  | 解析已加载的定义对象与 metadata，返回 `DeviceDescription`     |
| `loadDeviceModule()`        | 通过 `IDeviceProvider` 取得定义与 JS 代码，加载并校验默认导出 |
| `resolveDeviceProperties()` | 按描述默认值与实例覆盖值生成独立、递归冻结的属性快照          |
| `DeviceError`               | 带 `code`、`deviceId`、`pointer` 的设备层错误                 |
| `IDeviceProvider`           | 宿主实现：`resolve(deviceId)` 返回定义对象与 JS 代码          |
| `DeviceDescription` 等类型  | 描述、端口、工厂与加载结果                                    |

不导出文件路径 helper、文件缺失错误码、JSON 语法错误码或属性更新接口。

## Provider 合同

```ts
import type { DeviceDefinition, IDeviceProvider } from '@mica-js/device';
import { parseDeviceDescription } from '@mica-js/device';

const provider: IDeviceProvider = {
  async resolve(deviceId) {
    // 宿主负责定位/读取/缺失诊断与 JSON.parse。
    const loaded = await loadPackageContent(deviceId);
    return {
      definition: parseDeviceDescription(loaded.json, {
        name: deviceId,
        displayName: loaded.displayName,
        description: loaded.description,
      }),
      code: loaded.jsSource,
    } satisfies DeviceDefinition;
  },
};
```

- `deviceId` 是不透明字符串（例如 `zerobit:stm32f103c8t6`），本包不解析其格式。
- `resolve` 返回 `undefined` 表示器件不存在，`loadDeviceModule` 报 `device/device-unknown`。
- provider 抛出的 `DeviceError` 原样传播；其他异常包装为 `device/provider-failed` 并保留 `cause`。
- `definition` 必须是已经由 `parseDeviceDescription` 解析的 `DeviceDescription`。`loadDeviceModule` 只做运行时形状检查，不二次解析；provider 结果违约报 `device/provider-failed`。
- `code` 是器件实现的 ES 模块源码。provider 应提供自包含模块；相对导入不在本层解析。

## 描述解析

```ts
import { parseDeviceDescription } from '@mica-js/device';

const description = parseDeviceDescription(
  {
    properties: {
      label: { type: 'string', default: 'Display' },
      speed: { type: 'number', default: 72, min: 1, max: 170, unit: 'MHz' },
    },
    ports: {
      frame: { direction: 'output', type: 'bytes<rgb565>' },
    },
    designatorPrefix: 'U',
  },
  { name: 'acme:display', displayName: '显示屏', description: '示例显示器件' },
);
```

- `metadata.name` 必填；`displayName` 缺省回退 `name`；`description` 可选。
- `properties` 复用 `@mica-js/core/schematic` 的 #7 实现；不可用的属性描述被忽略，不猜测类型。
- `ports` 按 #10 校验：方向必须是 `input` / `output`，载荷类型取自封闭清单，未知字段报 `schema/unknown-field`，未知类型报 `type/unknown`。
- `designatorPrefix` 去除首尾空白；空字符串视为未声明。
- 顶层未知字段被忽略；定义对象只接受已解析对象，JSON 文本与语法错误属于 provider。

## 属性快照

```ts
import { resolveDeviceProperties } from '@mica-js/device';

const props = resolveDeviceProperties(description, { label: 'LCD' });
// props 已深拷贝并递归冻结；width、嵌套对象、数组均不可写。
```

- 按描述填默认值、校验覆盖值；颜色归一化为大写 `#RRGGBBAA`。
- 未声明的覆盖键静默忽略；无有效默认值且无覆盖时省略该键。
- 每次调用返回独立对象；外部覆盖对象或描述默认对象的后续变更不影响快照。
- 运行期写入冻结树会抛 `TypeError`；本包不提供属性更新、自动重建或 `onPropsChanged`。需要另一组属性时由宿主显式创建新实例。

## 加载与导出校验

```ts
import { loadDeviceModule } from '@mica-js/device';

const loaded = await loadDeviceModule('acme:display', provider);
// loaded.description 为解析后的描述；loaded.factory 尚未被调用。
```

- 浏览器使用 Blob URL、Node 使用 `data:` URL 动态 import 代码字符串。
- 默认导出必须是普通同步函数；`async` / async generator 报 `device/implementation-async`；非函数、generator、class 报 `device/implementation-export`；模块语法或求值失败报 `device/implementation-import`。
- **不调用工厂**。工厂上下文与生命周期由 #53 实现；同步函数返回 Promise 无法在加载期静态识别，留给 #53 在调用期拒绝。
- 不提供 WASM 兼容分支或第二个实现加载来源。

## 错误码

| 错误码                         | 含义                                                     |
| ------------------------------ | -------------------------------------------------------- |
| `device/device-unknown`        | provider 返回 `undefined`，或 device id 为空             |
| `device/provider-failed`       | provider 抛非 `DeviceError`、未实现 `resolve` 或结果违约 |
| `device/description-schema`    | 定义容器、metadata 或 `designatorPrefix` 形状错误        |
| `device/implementation-import` | 代码字符串不是可加载的 ES 模块                           |
| `device/implementation-export` | 默认导出不是普通同步函数（含 generator / class）         |
| `device/implementation-async`  | 默认导出声明为 async / async generator                   |
| `schema/invalid-type`          | #7/#10 字段类型错误                                      |
| `schema/invalid-value`         | #7/#10 字段取值错误                                      |
| `schema/unknown-field`         | #10 端口声明出现未知字段                                 |
| `type/unknown`                 | #10 端口载荷类型不在封闭清单                             |

`DeviceError` 的 `pointer` 使用 JSON Pointer 指向失败位置，便于宿主定位。

## 支持边界

本层不实现 #53 的工厂上下文与生命周期、#54 的消息桥接、#55 的引脚声明与 I/O 指令、#56 的观察投递、#57 的 `connection.apply`、#59 的 sandbox 执行适配，也不实现 #60/#61 的 Provider/checkpoint。文件定位、缺失文件与 JSON 语法诊断由 `IDeviceProvider` 负责；本包不以空实现冒充这些能力。

## 验证

在仓库根目录运行：

```powershell
pnpm --filter @mica-js/core build
pnpm --filter @mica-js/device test
pnpm --filter @mica-js/device typecheck
pnpm --filter @mica-js/device build
```

Vitest 使用真实临时目录中的 `.json` / `.js` 配对文件验证 provider 加载；覆盖所有 #7 属性类型、默认值、覆盖校验、未知键忽略、嵌套对象/数组冻结、外部别名变更、运行期写入拒绝、独立实例快照、#10 端口校验、各类导出错误与 provider 失败。跨包集成用例把解析结果送入 `@mica-js/core/schematic` 的 `createDeviceRegistry`，确认没有重复维护属性 schema。测试直接调用生产函数，不用构建或子进程冒充单元测试。

## 相关提案

- 属性定义：[#7](https://github.com/x-botlab/mica-js/issues/7)
- 器件 JavaScript 作者 API：[#8](https://github.com/x-botlab/mica-js/issues/8)
- 话题端口定义：[#10](https://github.com/x-botlab/mica-js/issues/10)
- 器件定义：[#11](https://github.com/x-botlab/mica-js/issues/11)
