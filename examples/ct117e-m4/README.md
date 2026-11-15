# CT117E-M4 单器件工程（STM32G431RBT6 + ILI9325）

`@mica-js/example-ct117e-m4` 把 CT117E-M4 上 MCU 与 ILI9325 的固定接线合成一个
器件模型：**一个 instance、一个 JIT**。它用于验证单器件融合路径和真实 Keil 固件的
运行行为，不是完整 CT117E-M4 开发板仿真。

- 器件 ID：`ct117e-m4`
- 源码：`src/devices/ct117e-m4/{model.ddl,index.ts,device.json}`
- 构建产物：`dist/devices/ct117e-m4/{device.js,device.json}`
- 参考固件：`HAL_06_LCD.hex`（测试夹具位于 `examples/stm32g431rbt6/bench`；器件运行时接收
  Flash 字节映像）

## 构建与检查

需要 Node.js 24（仓库当前使用 Node 24.20.0）。

```bash
cd examples/ct117e-m4
pnpm build        # 生成热函数 IR，然后 mica build
pnpm typecheck    # 生成热函数 IR、DDL 类型，然后 tsc --noEmit
pnpm test         # 构建并运行正确性测试
pnpm bench        # 构建并运行三轮基准
```

`pnpm test` 会先构建，再只从 `dist/devices/ct117e-m4/device.js` 装载产物；测试不会
退回 `src/`，也不会在测试里重新编译 DDL。

本工程本地保存 LCD 模型、适配器、融合变换和热函数展开器；MCU 内核来自工作区包
`@mica-js/stm32g431rbt6-core`（`examples/stm32g431rbt6-core`，`workspace:*` 开发依赖），
与 `examples/stm32g431rbt6` 共用同一份 Thumb 译码、总线/内存布局与外设模型。该包对外
提供 `/bus`、`/cpu`、`/decode`、`/gpio`、`/ir`、`/layout`、`/machine`、`/memory`、
`/nvic`、`/pwr`、`/rcc`、`/register-facts`、`/systick`、`/thumb16`、`/thumb32`、`/tick`、
`/usart` 子路径；`mcu.ts` 通过 `/layout`、`/ir`、`/decode`、`/machine`、`/gpio`、
`/memory`、`/systick`、`/usart`、`/nvic`、`/register-facts` 引用内核，只保留本器件的
属性、复位值与 JIT 编排。

`scripts/prepare-model.mjs` 在构建期编译本地 `model.ddl`，生成忽略提交的
`hot-model.ts`，供运行时展开 BlockIR 热函数；SDK 同时把完整模型编进最终产物。
`mica build` 在构建期把共享内核打包进产物，构建与运行不引用兄弟 example 的源码或
测试文件。`device.js` 是单个自包含模块，导出 `model` 和 `create`，运行时不加载共享包。

## 从构建产物加载

当前 SDK 的公开装配接口是 `createDeviceLibrary` + `createBoard`；器件包通过
`device.js` 导出的 `model`/`create` 登记。`device.json` 是给编辑器和目录扫描用的
元数据，不参与仿真装配。

```ts
import { readFileSync } from 'node:fs';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { create, model } from './dist/devices/ct117e-m4/device.js';

// firmware 必须是以 0x08000000 为起点的 Flash 字节映像。
// 本工程测试用 test/firmware.ts 解析 Intel HEX；HEX 文本不能直接传进来。
const firmware = new Uint8Array(readFileSync('firmware.bin'));

const board = createBoard(createDeviceLibrary([{ id: 'ct117e-m4', model, create }]), {
  instances: [
    {
      id: 'lcd-mcu',
      type: 'ct117e-m4',
      props: {
        firmware,
        clockFrequency: 80_000_000, // 固件 SystemClock_Config 配置的 SYSCLK
        refreshRate: 60,
      },
    },
  ],
  nets: [
    {
      id: 'vdd',
      voltage: 3.3,
      pins: [{ instance: 'lcd-mcu', pin: 'VDD1' }],
    },
    {
      id: 'vss',
      voltage: 0,
      pins: [{ instance: 'lcd-mcu', pin: 'VSS1' }],
    },
  ],
});

board.topics.onDidReceive(({ topic, payload }) => {
  if (topic !== 'framebuffer') return;

  const frame = payload as Uint8Array;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  console.log({
    x: view.getUint16(0, true),
    y: view.getUint16(2, true),
    width: view.getUint16(4, true),
    height: view.getUint16(6, true),
    bytes: frame.length,
  });
});

board.runUntil(0);

const target = 440_000_000_000;
while (board.time < target) board.runUntil(Math.min(board.time + 200_000_000, target));
board.dispose();
```

## 接线与运行设置

- 外部只连接 **VDD1 = 3.3 V、VSS1 = 0 V**。LCD 的 VDD/VSS、RST 以及 MCU 与 LCD
  之间的数据/控制线都在器件内部固定连接；RST 恒为高。
- MCU 与 LCD 的固定接法：`D0–D15 = PC0–PC15`，`WR = PB5`，`RS = PB8`，
  `CS = PB9`，`RD = PA8`。
- 单主机、理想数字总线；没有第二个总线主设备，也没有模拟竞争。
- `clockFrequency` 是模型的时间基准，必须与固件实际配置的主频一致；本固件为
  80 MHz。它不是自动从 RCC 寄存器反推的值。
- `refreshRate` 默认 60 Hz，控制脏矩形合帧发布的最大频率。
- `runUntil(0)` 完成复位和初始化；之后可用任意步长推进到目标时间。
- `execution` 使用默认的 `throughput`（直接后端）；本示例没有单独维护 precise 路径。

## 输出话题

- `framebuffer`：`Uint8Array`。开头是 8 字节小端矩形头：
  `x:u16, y:u16, width:u16, height:u16`；随后是 `width × height` 个
  **RGB565 小端**像素，行优先。总长度必须等于 `8 + width × height × 2`。
  每次发布的是一个合帧脏矩形，不保证是整屏；坐标以 320×240 面板为准。
- `fault`：`number`。MCU 模型报告的故障通知；载荷语义沿用 MCU 子集。
- `serial1.tx`、`serial2.tx`、`serial3.tx`：`number`。从 MCU 子集继承的 USART
  发送字节；没有发送活动时不会发布。

`framebuffer` 的矩形可能重叠或只覆盖局部区域，消费方应按顺序合成。没有脏像素时
不会发布空帧。

## 测试覆盖

`test/device.test.ts` 是正式交付产物用例：

- 从 `dist/devices/ct117e-m4/device.js` 装载并创建**单个** instance；
- 严格解析 `examples/stm32g431rbt6/bench/HAL_06_LCD.hex`，按 80 MHz 从复位推进到 220 ms / 440 ms；
- 固定工作量：220 ms 为 272,506 次 WR 电平变化、136,008 次 GRAM store、5 帧；
  440 ms 为 **545,004 次 WR 变化、272,007 次像素 store、10 帧、76,800 个非零
  像素**；
- 板状态保持 `ready`，无 error/fault；
- 最终 GRAM、寄存器文件、逐帧内容、精确 `frameInfo` 时间以及 MCU 状态/内存摘要
  与旧的分立 `examples/ili9325/test/joint-harness.ts` oracle 对账；
- 额外用独立总线 oracle 核对 MCU intent 计数、像素写次数与最终图像。

oracle 只在正确性用例中运行，不进入任何性能计时。它依赖兄弟 example 的测试夹具，
这是**测试依赖**，不是器件运行时的依赖。

`test/firmware.test.ts` 覆盖 HEX 解析器的记录格式、校验和、地址范围、EOF、重叠冲突
和不支持的记录类型。

测试默认读取 `examples/stm32g431rbt6/bench/HAL_06_LCD.hex`（与 `examples/stm32g431rbt6`
的基准共用同一份夹具）；如果夹具放在别处，可设置：

```bash
MICA_CT117E_M4_HEX=/path/to/HAL_06_LCD.hex pnpm test
```

期望的解析后 Flash 映像 SHA-256 为
`673d0b78c9376e0bae99761b6285cc2d2e00b3d44c6eefb7cf040a2992945650`，
长度为 10,804 字节，覆盖 `[0x08000000, 0x08002A34)`。夹具缺失或映像不一致时测试
会直接失败，而不是换用另一版固件。

## 基准

`bench/ct117e-m4-perf.test.ts` 只测正式构建产物的单 instance：

- 0 → 200 µs 为冷启动（建板 + 复位 + 首次翻译），200 µs → 220 ms 为 active，
  220 → 440 ms 为 post；
- 三轮独立建板，进程 CPU 与墙钟都输出；
- 每轮结束在计时之外校验 440 ms 工作量、帧数、非零像素以及 `ready`/无 fault；
- 不安装逐 intent oracle，不做大型性能矩阵。

运行：

```bash
pnpm bench
```

stdout 会输出 `CT117E_M4_PERF` 行和 `CT117E_M4_REPORT` 临时目录；`readings.json`
包含每轮的 CPU/墙钟、实时倍率和工作量快照。绝对耗时随宿主和 V8 状态变化，结论以
同机三轮读数为准。

2026-11-15，Node 24.20.0：构建、类型检查、8 项正确性测试及三轮基准通过。
测试确认产物创建单个 instance 和单个 JIT；三轮均完成上述 440 ms 固定工作量。

| 轮次 | 冷启动 CPU / ms | active CPU / ms | post CPU / ms | 总 CPU / ms | 总墙钟 / ms |
| ---- | --------------: | --------------: | ------------: | ----------: | ----------: |
| 1    |        5711.121 |        1696.914 |       200.539 |    7608.574 |    4803.857 |
| 2    |         209.898 |         644.505 |       206.970 |    1061.373 |     546.479 |
| 3    |         114.511 |         481.314 |       134.181 |     730.006 |     366.631 |

首轮包含首次翻译和 V8 预热。计时关闭测试侧的期望帧重组；这些正式产物读数与旧的
源码基准有夹具开销差异，不能据此推断算法进一步提速。

## 适用限制

- **固定 3.3 V、RST 恒高、单主机、理想数字总线**。LCD 数据读回要求 MCU 释放数据
  总线；模拟竞争、电阻强弱、浮空/模拟电平和任意外部接线不在本示例的验证范围内。
- **不是完整 CT117E-M4 开发板**。不包含按键、LED、蜂鸣器、继电器、EEPROM、温度
  传感器等板载外设，也不模拟它们的接线。
- **共享内核的 MCU 子集**：Cortex-M4 Thumb/Thumb-2 指令、GPIO、RCC、PWR（时钟配置
  所需）、SysTick、NVIC、USART1–3 发送、128 KiB Flash、22 KiB SRAM、10 KiB CCM
  SRAM；LCD 侧为 16 位 8080 并口、窗口寻址、GRAM 与 RGB565 帧发布。ADC、DAC、
  比较器、运算放大器、SPI、I²C、CAN、USB、RTC、看门狗和通用定时器等未建模。
- 器件运行时只接收 `firmware` 字节，不读取 HEX/BIN 文件；文件解析属于测试夹具。
- 本示例不能用来证明任意 CT117E-M4 固件或任意外部接线都与真实硬件等价；它只覆盖
  上述固定接法和 MCU 子集。
