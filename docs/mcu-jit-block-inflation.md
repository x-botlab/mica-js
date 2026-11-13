# STM32G431RBT6 MCU 模型的指令块膨胀分析

- 日期：2026-11-13
- 相关代码：`examples/stm32g431rbt6/src/devices/stm32g431rbt6/core/`
- 复现对象：`examples/ili9325/test/fixtures/HAL_06_LCD.bin`（CT117E-M4 的 Keil HAL 示例固件）

本文记录用真实 HAL 固件做 MCU + LCD 联合仿真时暴露出的性能问题：**每条翻译后的指令块平均承载 599 个 IR 操作，约为应有的 20–30 倍**。这是当前 MCU 仿真慢于实时 100–1700 倍的直接原因，与 LCD 器件无关。

## 1. 现象

用 `HAL_06_LCD.bin`（10,804 字节，初始 SP = `0x20000418`，复位向量 = `0x080001ED`，主频 80 MHz）单独跑 MCU，`execution: 'precise'`：

| 指标                             | 读数                                  |
| -------------------------------- | ------------------------------------- |
| 仿真 190 µs 的墙钟               | 13.5 s（约 71,000× 实时）             |
| 稳态（Translation 完成后）200 µs | 22 ms（约 110× 实时）                 |
| 稳态每条仿真指令的墙钟           | **约 1.4 µs**                         |
| 已执行并缓存的指令块             | 734                                   |
| 缓存块的 IR 操作总数             | **439,382**                           |
| 平均块体积                       | **599 op**（中位数 150，最大 10,179） |
| 体积 > 500 op 的块               | 278 个（38%）                         |

对照组：把 ILI9325 从板上摘掉，只留 MCU，同一时间窗的墙钟完全相同（13,475 ms 对 13,598 ms）。电气求解的统计是 204 次求解、2,302 次命中缓存、34 个 leaf 计划，占比可以忽略；`board.boundary()` 总耗时 8 ms，占 0.1%。

结论：**耗时集中在指令块体本身的执行上，不在电气求解、同步边界或 JIT 翻译。**

## 2. 最直接的证据

固件地址 `0x08000470` 是 `HAL_GetTick`，函数体只有两条指令：

```asm
08000470 <HAL_GetTick>:
 8000470:  6800  ldr r0, [r0, #0]
 8000472:  4770  bx   lr
```

它翻译出来的块有 **1,032 个 IR 操作**，其中：

```
readSample: 51   field: 51   if: 61   select: 87
binary: 318      constant: 301        load32le: 26
```

`bx lr` 既不解引用也不访存，却带上了整个外设分派树。这不是特例：统计全部 734 个块，`readSample` 出现 10,152 次（平均每块 13.8 次），`load32le` 8,311 次，`if` 29,005 个，`select` 30,982 个。

## 3. 根因

### 3.1 访存分派对动态地址无条件展开

`core/memory.ts:81` 的 `readMemory` 与 `core/memory.ts:163` 的 `writeMemory` 对任何 `Value<number>` 地址都发射完整的分派链：

```
Flash 别名 → SRAM → CCM → 外设区 → 系统区
                          ↓
        core/bus.ts: RCC → FLASH → PWR → USART1/2/3 → GPIO A–F → 通用后备区
                                                        ↓
                                             core/gpio.ts:71 readIdr
                                      16 脚 × (readSample + field + select + binary)
```

区间判定写的是 `core/memory.ts:46`：

```ts
const inRegion = (b, address, base, size) =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));
```

`address` 是 IR 值，所以即使实参来自 `num(b, 0x08000000)` 这样的**编译期常量**，也照样生成减法、比较和全部 `if` 分支。`push`/`pop`（23 + 22 次）、`ldr [pc,#imm]`、`ldr [sp,#imm]` 这类地址在翻译期完全已知的指令，仍然付出整棵树的代价。这些正是固件里最常见的访存形式（`ldr` 277 次、`str` 153 次）。

同一个 `inRegion` 在 `core/bus.ts:40` 再写了一份，外设区内又多一层链式判定。

### 3.2 GPIO IDR 组包是最贵的一支

`core/gpio.ts:71` 的 `readIdr` 为一根一根引脚拼出 16 位值：

```ts
for (let bit = 0; bit < port.pins.length; bit += 1) {
  const one = b.select(types.number, pinHigh(b, pin), ...);  // readSample + field + select
  result = result === undefined ? one : b.bitOr(result, one);
}
```

单个端口 16 根脚，每根脚要 `readSample` + `field` + `select` 三个操作再加一次 `bitOr` 合并，约 120 op。实测 `HAL_GetTick` 的块里 `readSample` 出现 51 次，覆盖 3 个以上端口。而 HAL 固件读 IDR 的次数极少，绝大多数块只是**顺带把它编了进去**。

### 3.3 每条指令都被 IT 块包装，层数被放大

`core/decode.ts:25` 的 `guarded()` 给每条指令套上「ITSTATE 非零才求值」的三段 `if`：

```
if (active) { ...计算 holds... }
if (holds)  { ...指令体... }
if (active) { ...推进 ITSTATE... }
```

指令体里再嵌 `tick()` 的服务跳转树与访存分派，于是单个块的 `if` 深度达到 9 层。实测某个块的路径是：

```
body[1].no[9].yes[9].no[6].no[6].no[6].yes[8].no[6].yes[12].yes[6].yes[0] readSample
```

### 3.4 异常帧弹出也走完整分派

`exceptionReturn` 的 8 个字固定落在 SRAM，但通过 `stackLoad` → `readMemory` 同样展开整棵树。固件里 SysTick 中断频繁，这条路径的代价被重复计入。

## 4. 影响

- **执行慢**：稳态 1.4 µs/指令。按 80 MHz、每次 SysTick 中断约 30 条指令估算，仅中断处理就把实时倍率拉到 100× 以上。
- **翻译慢**：439,382 个 IR 操作要全部过 builder 校验与代码生成，冷启动首批 5 µs 仿真约 1.5 s。
- **块体积触到分片阈值**：`compiler` 的「局部槽预算」会把这些巨块切成多片，额外增加派发开销；`direct` 后端的整程序重建也因此更慢。
- **与器件无关**：LCD 是否在板上对耗时没有影响，纯属 MCU 模型问题。

## 5. 修复方向

按收益与风险排序：

1. **常量地址折叠**（收益最大、风险最低）。给 `readMemory`/`writeMemory` 增加可选的静态地址视图：当 `address` 由 `num()` 构造时，在**翻译期**算出所属区间与偏移，只发射命中的那一支。可直接消掉 `push`/`pop`/`ldr [pc,#imm]`/`ldr [sp,#imm]` 的整棵树。
2. **IDR 组包移出指令块**。像 GPIO 写那样登记「待读端口」，由服务块完成组包；`readIdr` 只在服务块翻译一次。IDR 读本来不需要与指令原子。
3. **异常帧专用路径**。`exceptionReturn` 固定读 SP 起的 8 个字，属于 SRAM，绕开外设分派。
4. **IT 包装按需发射**（可选）。只有真正处在 IT 块内（`itState` 静态可知为 0）的指令才需要条件求值；静态为 0 时可省掉三段 `if`。
5. **引脚意图的 `select` 链压成位运算**（可选）。`emitPinIntent` 用 87 个 `select` 表达 MODER/OTYPER/PUPDR 组合，可以改为位运算加单次 `select`。

预期：第 1 + 2 项能把平均块体积从 599 op 降到 60–80 op（约 8×），冷启动与稳态同步受益。

## 6. 复现方法

```bash
cd examples/stm32g431rbt6
pnpm run build          # 产出 dist/devices/stm32g431rbt6/device.js

cd ../ili9325
MICA_JOINT=1 pnpm exec vitest run test/joint.test.ts   # 功能：断言 BSP 初始化序列写入 LCD
```

性能计量脚本（临时脚本，不入库）：

1. 用 `createBoard(..., { execution: 'precise' })` 建一块只含 MCU 的板；
2. 包装 `board.jits[0].cache.get` 统计块执行次数，包装 `board.boundary` 统计边界耗时；
3. 板到达稳态后按固定仿真时长切片计时；
4. 遍历 `jit.cache` 的每个 `instr.body.operations`，递归 `yes`/`no` 子块统计 op 数与 op 种类。

`bench/perf.test.ts` 里的 `gpio-blink`（1 MHz、500 ms 仿真）是同一路径的轻量基线，可用于验证改动前后不回归。

## 7. 附：本轮联合仿真中已修复的 MCU 模型缺陷

这些是让 HAL 固件能跑起来的前置修复，均已通过 `examples/stm32g431rbt6` 的 6 个回归用例。

| #   | 缺陷                                         | 症状                                                                                                                   | 位置                  |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | 32 位指令前缀只判 `0xE800`/`0xF000`          | `ldr.w sp`（`0xF8DF`）被当 16 位解码，PC 前进 2 字节后在向量表里执行数据                                               | `core/decode.ts`      |
| 2   | JIT 缓存键用 `pc & 0x1ffff`                  | `0x000001D8` 命中 `0x080001D8` 的块，报 `Translated first pc does not match`                                           | `index.ts`            |
| 3   | `ADD rd, SP, #imm`（`0xA800–0xAFFF`）误写 SP | `add r0, sp, #56` 顶高栈指针，`pop {pc}` 弹出 0                                                                        | `core/thumb16.ts`     |
| 4   | `ldm/stm` 忽略 W 位（bit5）                  | `__scatterload` 的基址被无条件写回，表指针错位后跳进向量表                                                             | `core/thumb32.ts`     |
| 5   | 缺 `lsl/lsr/asr/ror` 寄存器移位（`0xFA00`）  | 移位类型位置（h1 bit6..5）与操作数方向（Rn 为被移位值）都写错，`lsrs.w` 被当 `lsl.w`，`HAL_GPIO_Init` 的引脚循环不退出 | `core/thumb32.ts`     |
| 6   | 缺 `ldrd/strd` 立即数（`0xE940`）            | `SystemClock_Config`、`MX_GPIO_Init` 处 halt                                                                           | `core/thumb32.ts`     |
| 7   | `PWR->SR2` 无合成读回                        | `HAL_PWREx_ControlVoltageScaling` 轮询 `VOSF` 永不结束                                                                 | `core/pwr.ts`（新增） |

## 8. 已知限制

- 固件里累计超过 4 秒的 `HAL_Delay` 空转，按当前速度完整跑完代价过高；联合仿真用例只验证到 BSP 初始化寄存器写入完成。
- `JitOptions.polling`（空闲等待声明）目前不能用于 `HAL_Delay`：模型的 SysTick 推进挂在指令块执行上，一旦循环体被跳过就再没人推进 `uwTick`，会死锁。要支持它，需要把 SysTick 改成时间驱动的 `process`（参照 `examples/ili9325` 里 `publishFrames on frameSeq` 的写法），这会改动中断时序语义，需配合现有 `systick` 夹具验证。
