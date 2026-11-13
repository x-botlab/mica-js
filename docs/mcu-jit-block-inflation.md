# STM32G431RBT6 MCU 模型的指令块结构

- 日期：2026-11-13
- 相关代码：`examples/stm32g431rbt6/src/devices/stm32g431rbt6/`
- 复现对象：`examples/ili9325/test/fixtures/HAL_06_LCD.bin`（CT117E-M4 的 Keil HAL 示例固件）
- 缺陷登记与性能读数：`docs/stm32g431rbt6-issues.md`（本文只讲块结构，不重复数据）

本文解释「为什么一个 Thumb 指令块会膨胀到几百个 IR 操作」，以及本轮为压缩块体所做的改动。
所有读数与基准口径都在 `docs/stm32g431rbt6-issues.md` 第 0、2 节，本文不维护第二份数字。

## 1. 现状

真实 HAL 固件、裸 MCU、80 MHz、`throughput` 下跑到 220 ms，缓存块 411 个、直接程序 1 份。
块的构成是：**一批最多 8 条顺序指令的数据通路 + 块尾一次 `elapse`**；外设推进、异常派发与
GPIO 引脚意图都在按需翻译的服务块里。

## 2. 根因

### 2.1 访存分派对动态地址无条件展开

`core/memory.ts` 的 `readMemory` 与 `writeMemory` 对任何 `Value<number>` 地址都发射完整的分派链：

```
Flash 别名 → SRAM → CCM → 外设区 → 系统区
                          ↓
        core/bus.ts: RCC → FLASH → PWR → USART1/2/3 → GPIO A–F → 通用后备区
                                                        ↓
                                             core/gpio.ts:71 readIdr
                                      16 脚 × (readSample + field + select + binary)
```

区间判定写作一次「减基址后按 32 位无符号比较」：

```ts
const inRegion = (b, address, base, size) =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));
```

`address` 是 IR 值，所以即使实参来自 `num(b, 0x08000000)` 这样的**编译期常量**，也照样生成减法、比较和全部 `if` 分支。`push`/`pop`、`ldr [pc,#imm]`、`ldr [sp,#imm]` 这类地址在翻译期完全已知的指令，仍然付出整棵树的代价，而它们正是固件里最常见的访存形式。

`core/bus.ts` 对外设区又写了一份同样的 `inRegion`，区内再多一层链式判定。

### 2.2 GPIO IDR 组包是最贵的一支

`core/gpio.ts` 的 `readIdr` 为一根一根引脚拼出 16 位值：

```ts
for (let bit = 0; bit < port.pins.length; bit += 1) {
  const one = b.select(types.number, pinHigh(b, pin), ...);  // readSample + field + select
  result = result === undefined ? one : b.bitOr(result, one);
}
```

单个端口 16 根脚，每根脚要 `readSample` + `field` + `select` 三个操作再加一次 `bitOr` 合并，约 120 op。实测 `HAL_GetTick` 的块里 `readSample` 出现 51 次，覆盖 3 个以上端口。而 HAL 固件读 IDR 的次数极少，绝大多数块只是**顺带把它编了进去**。

### 2.3 每条指令都被 IT 块包装，层数被放大

`core/decode.ts` 的 `guarded()` 给每条指令套上「ITSTATE 非零才求值」的三段 `if`：

```
if (active) { ...计算 holds... }
if (holds)  { ...指令体... }
if (active) { ...推进 ITSTATE... }
```

指令体里再嵌 `tick()` 的服务跳转树与访存分派，于是单个块的 `if` 深度达到 9 层。实测某个块的路径是：

```
body[1].no[9].yes[9].no[6].no[6].no[6].yes[8].no[6].yes[12].yes[6].yes[0] readSample
```

### 2.4 异常帧弹出（本版本已不再走完整分派）

`exceptionReturn` 的 8 个字固定落在 SRAM/CCM，`nvic.ts` 的 `stackLoad`/`stackStore` 只做 SRAM、CCM 两次区间判定，没有调用通用分派；这一条在当前代码里已经不成立。

### 2.5 非 GPIO 外设写也内联读改写链

`writeMemory` 的外设分支里，GPIO 写已被延迟到服务块，但 RCC/USART/PWR/FLASH 与通用后备区仍在指令块内做「读当前字 → 合并 → 写回」。动态地址的每条 `str` 都会把这些分支全部展开一次。

## 4. 已实施的修复与效果

### 4.1 静态区间视图（原第 1 项）

`core/memory.ts` 新增 `At` 声明：`ldr [pc, #imm]` 只可能落在 `code`，`push`/`pop` 与所有 SP 相对访存只可能落在 SRAM。命中静态区间的访存只发射该区间的一条路径，常量地址连基址减法都省掉（`atCode(offset)`）。

改造覆盖：Thumb-16 的 LDR literal、SP 相对与 push/pop；Thumb-32 的 PC/SP 相对 `ldr.w`/`str.w`、`ldm/stm`、`ldrd/strd`、`tbb`。多寄存器指令的每个寄存器不再各带一棵分派树，`pop.w {r2-r11, pc}` 这类块体因此回到两位数量级。

### 4.2 GPIO IDR 延迟读（原第 2 项）

IDR 需要逐脚读采样再拼字，无法安全缓存：采样值会在板级边界变化，服务块里算好的缓存到下一块就可能过期。实际做法是把**指令块内的组包**换成**登记 + 服务块组包**：

- 指令块命中 GPIO IDR 时只写 `deferRead*`（端口、偏移、目标寄存器、宽度、符号扩展），结果先按 0 写回；
- `tick` 优先把 PC 转给 `SERVICE_READ`，由它在服务块里逐脚组包、取宽度、符号扩展，再按寄存器号写回；
- 服务块以登记位做幂等保护，重复派发不会重复写。

多寄存器装载（`ldm`/`pop`/`ldrd`）也可以共用同一槽位：地址逐字递增，最多只有一个寄存器会命中 IDR。写 PC 的装载保持内联。

副作用是 IDR 在**指令之后的下一个同步点**采样，而不是块内采样；对「拉低 RD → 边界 → LCD 驱动 → 读 IDR」这类时序反而更贴近硬件。`gpio-input` 与联合仿真用例均通过。

代价出现在「每条指令都读 IDR」的极端轮询循环里：精确模式下每次读都要多一次服务块派发，
因此比内联慢一截；常规固件（IDR 读只占访存的少数）走的是收益方向。

### 4.3 非 GPIO 外设写延迟（原第 3 项）

`SERVICE_WRITE` 承担非 GPIO 外设写：指令块只登记地址、宽度与值，服务的块里按宽度展开 1/2/4 三条完整写路径。GPIO 写仍在块内登记，因为它必须在同一块之后立即被 `SERVICE_GPIO` 取走，延迟会改变「写寄存器 → 读 IDR」的顺序。

### 4.4 当前规模与剩余热点

上述三项加上批处理之后，多寄存器访存不再按寄存器重复分派树，IDR 与非 GPIO 写只在服务块里
展开一次，IT 守卫只对真正在 IT 块内的指令发射。当前 HEAD 的 411 个可编译块合计约
**6,560 个顶层 IR 操作、310,231 个含嵌套 IR 操作、186,350 条发射语句、约 5.4 MB 生成源码**。

其中：

- 普通指令块按 8 条一批收集，实测平均约 3.61 条 guest 指令、733 个嵌套操作、438 条语句；
- `SERVICE_WRITE` 与 IDR 的大块主要影响首次翻译，稳态执行次数很少；
- GPIO 写服务在 220 ms 内执行约 109 万次，是稳态热路径，不只是冷启动体积问题；
- ODR/BSRR/BRR 现在按实际变化引脚生成同步掩码，配置寄存器也按字段压缩出精确变化位；服务块
  仍较大，但动态刷新只处理真正变化的引脚，并按 4 位分组筛选。

因此体积优化要按两类收益分别评估：服务块体量主要降低冷启动和生成源码大小；GPIO 服务路径和
shard/dispatcher 才直接决定程序稳定后的执行吞吐。

## 5. 相关文档

- 缺陷登记、基准口径与性能范围：`docs/stm32g431rbt6-issues.md`
- 执行期热点与动态计数：`docs/stm32g431rbt6-execution-bottlenecks.md`
- 重建成本与稳定窗口边界：`docs/direct-jit-rebuild-cost.md`
- 器件使用说明与交付基准：`examples/stm32g431rbt6/README.md`
