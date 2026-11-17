# 器件类型生成

- Start Date: 2026-11-16
- Reference Issues: —（尚未实现）
- Implementation PR: —（尚未实现）

规定统一器件开发项目的 SDK 类型准备、固定类型名、全局声明与生成配置。本文为待实现合同；运行时方法与事件由 [RFC 0021](./0021-device-model-api.md) 规定。MUST / MUST NOT 表示强制要求，SHOULD 为推荐，MAY 为可选。

修订（2026-11-17）：程序属性按 [RFC 0026](./0026-firmware-properties.md) 的 `loader` 投影为内存或文件集类型。

## 声明

### 项目与生成类型

- 一个开发项目对应 [RFC 0020](./0020-unified-device-package.md) 的一个器件包；公共属性、类型、方法、事件和引脚 ID 均以该包清单为声明来源。
- 公共载荷类型、方法与事件分别读取 `model.types`、`model.methods`、`model.events`，类型引用在当前 `model.types` 内解析；属性与引脚仍读取根 `properties`、`pins`。
- 核心上下文的输入通道、内存和输出批次类型来自模型资源声明；DDL 使用现行类型投影，准备期间不创建运行实例或调用模型工厂。
- SDK 在项目根生成 `.mica/device.d.ts` 与 `.mica/tsconfig.json`；`.mica` 由 SDK 维护，项目版本控制 SHOULD 忽略，可通过准备命令重新生成。
- `device.d.ts` 使用 `declare global` 提供下列固定名称，不将器件名称编码进类型名；作用域限定在当前器件项目的 TypeScript 配置内。
- 作者源码直接使用生成的类型名称；运行时函数仍按需显式导入 SDK。

| 类型                 | 含义                                                           |
| -------------------- | -------------------------------------------------------------- |
| `DeviceProps`        | 全部清单属性解析后的只读值类型，包含默认值补全与声明的可空性   |
| `DeviceMethods`      | 清单方法的同步实现类型，每个方法接收一个声明参数并返回声明结果 |
| `DeviceEvents`       | 事件名到载荷类型的映射，用于投影模型出口与客户端订阅           |
| `DeviceModelContext` | 核心能力、完整属性快照与按事件名生成的发出接口                 |
| `DeviceFactory`      | 同步模型工厂，约束方法实现、`sync` 批次和释放钩子              |
| `DeviceClient`       | 当前器件的异步方法代理与 `Event<ModelEvent<T>>` 订阅接口       |
| `DevicePinId`        | 清单引脚 ID 的字符串字面量联合；无引脚时为 `never`             |

- `integer` 与 `number` 生成 `number`，`color` 生成字符串，枚举生成选项值字面量联合；`nullable: true` 加入 `null`，已补全的属性键保持必需。
- `image` / `binary` 的解析值使用核心 `ReadonlyBytes`；`program` 的 `loader: "memory"` 使用 [RFC 0026](./0026-firmware-properties.md) 的 `MemoryProgram`，`loader: "filesystem"` 使用 `ProgramFiles`；可空时分别加入 `null`，作者直接使用确定的装载结果类型，文档引用不投影为工厂属性。
- `DeviceMethods` 保持同步签名，`DeviceClient.methods` 将同一参数与结果投影为 Promise 调用；无参数或结果按 [RFC 0021](./0021-device-model-api.md) 使用 `null`。
- 模型事件出口按 `DeviceEvents` 生成 `.fire(value)` 与 `.fireTransferred(value, buffers)`；订阅端将同一载荷包装为含 `value`、`simTime`、`sequence` 的单个事件参数。

## 运行时

### 准备、监听与构建

- `mica prepare` 读取构建配置定位的器件清单与模型声明，完成结构、类型引用、属性一致性及引脚一致性校验，再生成项目类型环境。
- 生成配置通过 `files` 加载声明、`include` 选择源码；作者配置通过 `extends: "./.mica/tsconfig.json"` 继承，可追加编译选项或覆盖 `include`，显式覆盖 `files` 时须保留生成声明。
- `mica prepare --watch` 监听清单、模型声明及构建配置变更，串行更新类型；生成输出的写入不触发自身循环，内容相同的输出保持不变。
- `mica build` 在编译前执行同一准备流程，类型环境与当前构建输入一致；准备失败阻止构建，不使用旧声明声称构建成功。
- 单次准备失败返回非零退出状态并定位清单字段或模型声明；监听模式报告错误并继续监听，输入修复后重新生成。
- 生成阶段只提供类型环境；模型状态、事件监听、RPC 连接和界面实例在运行时按各自合同创建。

## 校验

- 清单未知成员、类型引用错误、模型与清单属性不一致或引脚集合不一致时，准备 MUST 失败并报告原有清单或模型诊断。
- 模型 IR 只对清单中的普通属性做类型一致性校验；IR 声明同名 `program` 属性时准备失败，程序复合值只投影给工厂与展示。
- 缺少方法实现、参数或返回值错误、事件载荷错误及访问未知成员时，生成类型 MUST 使作者代码的 TypeScript 检查失败。
- 编译后的公开类型与运行时载荷校验使用同一清单；通过 TypeScript 检查不替代运行时校验。

## 示例

项目配置：

```json
{
  "extends": "./.mica/tsconfig.json"
}
```

使用默认 `src` 源码目录时，生成配置包含现行 SDK 的编译选项和当前项目声明：

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
  "files": ["./device.d.ts"],
  "include": ["../src"]
}
```

下面以具有两个数值属性、一个亮度输出、一个查询方法和一个事件的 LED 为例，展示生成声明。内部核心类型随模型声明投影；本例没有输入通道或公开内存。

```ts
import type {
  ChannelMessage,
  DeviceBatch,
  DeviceContext,
  ModelClient,
  ModelContext,
  ModelInstance,
} from '@mica-js/sdk/device';

type CoreContext = DeviceContext<DeviceProps, Record<never, never>, Record<never, never>>;
type Batch = DeviceBatch<{ readonly brightness: readonly ChannelMessage<number>[] }>;

declare global {
  type DeviceProps = {
    readonly forwardResistance: number;
    readonly ratedCurrent: number;
  };
  type DeviceMethods = {
    readonly getBrightness: (params: null) => number;
  };
  type DeviceEvents = { readonly onDidBrightnessChange: number };
  type DeviceModelContext = ModelContext<CoreContext, DeviceProps, DeviceEvents>;
  type DeviceFactory = (context: DeviceModelContext) => ModelInstance<DeviceMethods, Batch>;
  type DeviceClient = ModelClient<DeviceMethods, DeviceEvents>;
  type DevicePinId = 'anode' | 'cathode';
}
```

作者实现的 `methods` 可直接标注为 `DeviceMethods`，工厂标注为 `DeviceFactory`；展示通过 `DeviceClient` 调用异步方法与订阅事件，无需导入生成声明。

## 范围

- 包清单、身份、属性及引脚声明由 [RFC 0020](./0020-unified-device-package.md) 规定。
- 工厂、方法、事件及二进制所有权由 [RFC 0021](./0021-device-model-api.md) 规定。
- 程序镜像、文件集和模型工厂装载由 [RFC 0026](./0026-firmware-properties.md) 规定。

## 关联

- [RFC 0025](./0025-fused-runtime.md)：融合模式运行装配与验收。
