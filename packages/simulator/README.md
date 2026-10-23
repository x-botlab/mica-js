# @mica-js/simulator

在一条虚拟时钟上运行原理图里的全部器件实例：`loadSchematic` 建实例，`advance` 推进时间，`onPublish` / `deliver` 与画布互投载荷。

依赖方向：`@mica-js/simulator` → `@mica-js/device` → `@mica-js/ir` → `@mica-js/core`。

## 用法

推荐直接挂到 `WidgetHost` 上：宿主按 `bindings` 完成双向路由，应用侧不再手写转发。

```ts
import { timePs } from '@mica-js/core';
import { parseSchematic } from '@mica-js/core/schematic';
import { createDeviceSimExecutor } from '@mica-js/simulator';
import { createWidgetHost } from '@mica-js/widget';

const executor = createDeviceSimExecutor({
  devices: provider, // IDeviceProvider：器件描述 + 代码，原理图里只写 device id
  onDiagnostic: (diagnostic) => console.warn(diagnostic.code, diagnostic.message),
});

// 器件发布 → 绑定的 widget；widget 发布 → 绑定的器件端点。
const host = createWidgetHost({ provider, assets, simulation: executor });

await executor.loadSchematic(parseSchematic(schText)); // 文本由调用方解析
const report = executor.advance(timePs(100_000)); // 100 ns，同步完成
```

`DeviceSimExecutor` 结构上满足 `@mica-js/widget` 的 `WidgetHostSimulation`，不需要适配层；宿主之外也可以自己订阅 `onPublish` / 调用 `deliver`。

## 接口

| 成员                       | 说明                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `getState()`               | `'idle'`、`'ready'`、`'faulted'`、`'disposed'`；只有 `ready` 能推进 |
| `getSimTime()`             | 当前虚拟时间；首次加载前为 `0`                                      |
| `getSchematic()`           | 当前运行时的来源文档；首次加载前是空图                              |
| `getTopics()`              | 每个实例的端口，`symbol` + `port` 与画布绑定的端点一一对应          |
| `loadSchematic(document)`  | 按符号建实例并跑 `initialize`，时钟归零；构建失败时旧运行时原样保留 |
| `advance(delta)`           | 同步推进 `delta` 皮秒，返回 `{ from, to, executed, reason }`        |
| `onPublish(listener)`      | 器件发布 `(target, payload, simTime)`；返回取消订阅函数             |
| `deliver(target, payload)` | 排入下一次 `advance` 的开头，同一时刻多次调用按调用顺序被器件看到   |
| `reset()`                  | 丢弃实例、按当前原理图重建，时钟归零；同步                          |
| `dispose()`                | 销毁全部实例并释放运行时；同步、幂等                                |

`DeviceTopic` 的 `direction` / `type` 与 `DevicePortDescriptor` 同构，宿主可以直接用 `getTopics()` 生成画布的绑定候选。

## 语义

- **除 `loadSchematic` 之外全是同步的。** 加载之所以返回 promise，只因为器件模块要经 provider 取；模块随后被缓存，`reset()` 直接用缓存重建实例，不会再让出线程。仿真与 `WidgetHost` 跑在同一个 JS 线程上，没有 worker，也没有消息通道。
- **先建后换。** `loadSchematic` 在新调度器上建好实例、跑完 `initialize` 后才替换旧运行时，因此器件解析失败或工厂抛错时，正在跑的仿真不受影响，时钟也不回退。
- **`advance` 是同步的。** 整个时间片在调用内跑完，宿主可以在帧循环里直接调用并立刻拿到报告；推进失败时 `getState()` 变成 `'faulted'` 并原样抛出底层 `SchedulerError`。
- **`deliver` 收 `unknown`，延迟到时间片开头。** 宿主转发的是 widget 发布的原始载荷，端口类型由器件层校验；同一时刻多次投递按调用顺序被器件看到，UI 线程不会把载荷插进两次 `advance` 之间。
- **`simTime` 由执行器负责。** 器件发布时的时间戳取自调度器，画布侧不需要传时间。
- **诊断不中断仿真。** `onDiagnostic` 抛错会被吞掉；只有 `advance` 的调度器故障才会把状态置为 `'faulted'`。

诊断码以 `simulator/` 开头：`device-load-failed`、`instance-create-failed`、`advance-failed`、`publish-failed`、`dispose-failed`。宿主调用的参数错误抛 `SimulatorError`（`code` 见 `SimulatorErrorCode`）。

## 边界

- **引脚、网络与电气求解尚未接入。** 实例目前只挂话题端口；IR 里用到引脚或连接指令的器件会在加载时报 `device/connection-unavailable` 之类的器件层错误。网表、电源域与引脚宿主属于下一里程碑。
- 器件代码在宿主 realm 里求值（与 `loadDeviceModule` 相同，等同可信扩展），沙箱化未做。
