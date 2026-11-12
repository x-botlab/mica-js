# IAP15F2K61S2 器件包

STC15F2K60S2 系列 8051 单片机的 Mica 器件工程。器件 ID 是 `iap15f2k61s2`，源码按
**内核**（`kernel/`）与**外设**（`peripherals/`）拆分：内核把一条 8051 指令在翻译期展开成一条
IR 指令分组，外设在同一指令边界按经过的仿真时间推进。

工程位于仓库的 `examples/iap15f2k61s2`，纳入 pnpm workspace（包名
`@mica-js/example-iap15f2k61s2`）：`pnpm --filter @mica-js/example-iap15f2k61s2 build|typecheck|test|bench`。
测试与基准会用兄弟工程 `../ideal-led` 的夹具，因此两个目录必须并排放在 `examples/` 下。

## 目录

```
examples/iap15f2k61s2/
  mica.config.ts                       Mica 工程标志
  package.json                         build = mica build，typecheck = mica prepare && tsc --noEmit
  tsconfig.json
  vitest.config.ts
  src/devices/iap15f2k61s2/
    device.json                        34 个引脚、firmware/clockFrequency 属性、symbol
    model.ddl                          程序存储器 / 内部 RAM / SFR / 扩展 RAM / 外设状态 / EEPROM
    index.ts                           attachJit 入口：取指、外设节拍、中断派发
    kernel/                            内核
      ir.ts                            取值/访存辅助、SFR 常量、MOVX 与位寻址
      sfr-hooks.ts                     按实例注册的 SFR 读写钩子
      machine.ts                       一次翻译的活动上下文（时钟、外设、中断控制器）
      tick.ts                          外设节拍：时间累积、门控、共享推进服务块
      decode.ts                        8051 操作码解码（256 个操作码、指令长度）
      alu.ts                           PSW/ACC 的算术数据通路（ADD/ADDC/SUBB/DA）
      cycles.ts                        指令耗时表（手册 5.2 的 STC15 1T 列）
      interrupt.ts                     中断优先级、向量响应与 RETI
    peripherals/
      types.ts / layout.ts             外设合同与 periph 存储器分区
      ports.ts                         P0–P3 四种口模式、读引脚、复用功能仲裁
      timer.ts                         T0/T1/T2、计数/定时、自动重装、时钟输出
      uart.ts                          UART1/UART2：模式 0–3、波特率、TX/RX、SM2
      adc.ts                           10 位 ADC：8 通道 + BandGap、转换时钟、中断
      pca.ts                           PCA/CCP：捕获、16 位定时器、高速输出、PWM
      spi.ts                           SPI 主模式：SPCTL/SPSTAT/SPDAT、四种时序
      iap.ts                           IAP/EEPROM：读/写/扇区擦除与等待时间
      watchdog.ts                      看门狗：预分频、喂狗、溢出复位
      extint.ts                        INT0–INT4：边沿/双沿、下降沿
      clock.ts                         PCON/CLK_DIV、低压检测 LVD
  test/                                板级测试：harness.ts 测产物，source-harness.ts 测源码
```

构建产物（`dist/`，即上传归档的内容）：

```
dist/devices/iap15f2k61s2/{device.json, device.js}
```

## 模型要点

- **时间基准**：`clockFrequency`（默认 11 059 200 Hz）是 1T 系统时钟；每条指令按
  `kernel/cycles.ts` 的时钟数推进仿真时间，`kernel/cycles.ts` 的数值来自手册第 5.2 节的
  「STC15 系列所需时钟」列（例如 `SJMP` 3 个、`RET` 4 个、`DJNZ Rn` 4 个、`DIV AB` 6 个）。
- **外设节拍**：指令块只累积时间与一个门控字节，真正的推进集中在一个固定 PC 的服务块
  （`kernel/tick.ts`）：`index.ts` 的 `TICK_DIVISOR`（4）让节拍点每 4 条指令出现一次，
  节拍点指令执行完后若「有外设可能自行变化」或「有中断待派发」，就把 PC 转给服务块，
  由它一次性推进全部外设、重算门控、派发中断再跳回保存的下一条 PC。两次节拍之间累积的
  时间精确到皮秒，只有「谁先看到变化」的粒度是若干条指令；中断请求标志也只在节拍处更新，
  因此中断响应延迟同样以节拍为界。节拍按 PC 选取，因此回跳距离不足 4 字节的转移指令
  （`JNB RI,$` 这类轮询与 `SJMP $` 这类自循环）每个回跳都推进一次，避免紧循环整圈都落在
  节拍之间导致外设停摆；任何长度不小于 4 字节的循环都必然跨过一个节拍 PC。
  端口锁存与引脚意图仍然按指令写入，位操作与软件时序不受节拍影响。
- **服务块与直接后端**：空闲（没有外设可能自行变化、也没有中断待派发）时指令块只做
  「读两个字节 + 加一个常量 + 写一个 state」，可以直接编译；推进代码只存在于服务块里，
  因此不再随 PC 数量放大。服务块含引脚采样与嵌套 redirect，永远不会进入直接后端。
  读外设状态（计数器、请求标志、移位缓冲、捕获值，见 `peripherals/index.ts` 的
  `SYNC_ON_READ`）之前会先把累积时间推进掉，因此读到的值不比指令边界旧。
- **块缓存**：`index.ts` 另按「指令字节 + 系统时钟」缓存翻译结果，键里带指令字节所以
  自修改代码不会命中旧块；同一段固件在多块板上运行时只有第一块板付翻译代价。
  服务块按「系统时钟」单独缓存一份，与 PC 无关。
- **中断**：请求标志都是 SFR 位；外设置位后调用 `markIrqDirty`，内核在节拍边界按
  IP/IPH 优先级与当前中断优先级选出最高优先级的可响应源，压返回地址并转向向量；
  `RETI` 恢复优先级栈。
- **端口复用**：TXD、SCLK/MOSI、PWM/CCP、定时器时钟输出通过 `registerAlternateDriver`
  覆盖引脚输出，且要求该脚不是「仅输入」模式——把 P1 设成仅输入即可用 ADC 或按键。
  读口返回引脚电平，读-改-写指令读锁存器。
- **外设状态**：不可见的内部状态（计数余量、移位寄存器、相位、捕获影子、中断优先级栈）
  保存在 `model.ddl` 的 `periph` 存储器里，分区见 `peripherals/layout.ts`。

## 性能现状

基准是 `bench/perf.test.ts`：固件 `stc15-led-blink`（P1.1 每 33.205 ms 翻转一次，全部时间
花在两层 `DJNZ` 延时环上），11.0592 MHz，预热 20 ms 后测 500 ms 仿真。同机读数取
3 次运行的最小值（另一器件的基准并行跑过，读数会偏高）：

| 版本              | coldMs | wallMs | slowdown | jit                                        |
| ----------------- | ------ | ------ | -------- | ------------------------------------------ |
| 节拍块内联推进    | 5071   | 37519  | 75       | `direct:true`，9 个块里只有 2 个可直接编译 |
| 服务块 + 时间累积 | 450    | 222    | 0.4      | `direct:true`，9 个块全部可直接编译        |

关键是**让紧循环的块可以直接编译**：延时环里没有外设活动、没有待派发中断，因此只有
「累积时间 + 两个门控字节」，推进代码改由服务块承担。外设真的在动时（`SJMP $` 空转 +
定时器运行），每个节拍会进一次服务块，吞吐回落到解释器水平，但语义与逐块内联推进相同。

上限说明：直接后端的每条指令都要按顺序求值 `case C[n]` 标签（见下），19 个块时约
11 MIPS，因此默认 11.0592 MHz 有 2.5 倍以上余量、40 MHz 上限约 0.5×；而引擎自带的
`compileBody` 基准走生成器路径，不经过这条派发，不能用来推断器件指令吞吐。

```powershell
pnpm run bench             # 追加一行到 bench/results.jsonl
```

## 属性

| 属性             | 类型   | 默认值   | 说明                                            |
| ---------------- | ------ | -------- | ----------------------------------------------- |
| `firmware`       | bytes  | 空       | 裸二进制映像：字节写入 0000H 起的程序存储器     |
| `clockFrequency` | number | 11059200 | 1T 系统时钟（Hz），决定指令耗时、定时器与波特率 |

## 已知简化

- 省电模式（PCON.PD/IDL）只保留寄存器位，不清停 CPU：本模型的时间只随指令推进。
- `CLK_DIV` 保存分频值但不改变指令耗时；时间基准由 `clockFrequency` 属性给出。
- 外设按 4 条指令的节拍推进：`SJMP $`、`JNB RI,$` 这类回跳距离不足 4 字节的循环每个
  回跳都推进一次（串口靠它把位边沿细化到一条指令之内），其余代码每 4 条指令推进一次。
  计数值与经过时间仍然精确，只有「外设何时看到引脚变化」与中断响应延迟以节拍为界。
- 推进发生在一个共享的服务块里（`kernel/tick.ts`），推进代码不再内联进每个节拍块；
  但服务块本身仍然包含全部 10 个外设的推进 IR（约 1.2 MB IR，翻译一次约 0.6 s）。
  它只在「有外设可能自行变化」时才被首次执行与翻译，空闲固件（纯延时/纯 GPIO）完全
  不付这份代价。外设活动判定全部读寄存器位或内部标志，不采样引脚。
- 引脚采样是「按需」的：定时器只在计数方式（C/T）采计数脚、只在 GATE=1 采门控脚；
  外部中断只采已使能（EXn）的输入；低压检测只在 LVD 中断允许或已判定为低压时采 VCC。
  因此未使能外部中断时不建立边沿基线，使能后从使能时刻的电平开始比较。
- 端口写入仍按整口生成引脚意图（8 根脚各一份），只对写入的口生效；位测试只采目标脚。
- 16/32 位外设状态仍用 `load16/32`/`store16/32` 访问：这些块本来就要采样或写意图，
  换成字节组合不会让它们进入直接后端，只省一点 IR 体积。
- IAP 的字节读没有等待：手册里 CPU 在 IAP 期间停顿，这里改为触发时立即读回，否则
  「触发后紧跟一条 `MOV A,IAP_DATA`」会读到上一次的数据。编程与擦除仍按 WT2:WT0
  排入待执行状态，由节拍推进完成。
- UART2 只实现 P1.0/P1.1 一组位置（本器件没有 P4）；自动地址识别（SADDR/SADEN）与中继广播未建模。
- UART 模式 0 只建模 TXD 的同步移位时钟；RXD 串行数据输出与同步接收未建模。
- 看门狗溢出按「恢复 SFR 复位值 + PC=0」实现模型化复位，`periph` 里的外设中间状态不清零。
- IAP 的 ISP 下载、软件复位（IAP_CONTR.SWRST）未建模。

## 验证

```powershell
cd dist\iap15f2k61s2
pnpm run typecheck        # mica prepare && tsc --noEmit
pnpm run test             # mica build + ideal-led 夹具 + vitest
```

测试分两层：`test/source-harness.ts` 用 `compileDDL` 现场编译 `model.ddl` 并直接装载 `src/`，
外设用例因此不必先构建；`test/harness.ts` 装载 `dist/` 产物，保证交付件本身也被验证。
`vitest.config.ts` 让测试文件串行执行：每个用例都要新建板并翻译指令块，并发只会互相抢
线程、把几十秒的用例拖成超时。整套用例约 3.5 分钟，其中 192 例的 ALU 差分与实时闪烁用例
占大头。
