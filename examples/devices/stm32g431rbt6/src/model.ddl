/**
 * STM32G431RBT6（LQFP64，Arm Cortex-M4F）的器件模型。
 *
 * 行为不写在 DDL 里：Thumb/Thumb-2 指令、GPIO、RCC、SysTick、NVIC 与 USART 都由
 * `@mica-js/stm32g431rbt6-core` 在翻译期生成 IR。DDL 只声明资源与复位值：
 * - `code` 是 128 KiB Flash 的字节映像，JIT 从它的 0x00000–0x1FFFF 偏移取指；
 * - `sram` 是 22 KiB SRAM1（0x20000000），`ccm` 是 10 KiB CCM SRAM（0x10000000）；
 * - `r0`–`r12`、`sp`、`lr` 用 state 保存（寄存器不可寻址，state 比字节内存快），
 *   PC 单独作为 JIT 绑定的 state；
 * - `periph` 保存外设寄存器的不可见后备值，分区见 `@mica-js/stm32g431rbt6-core/layout`；
 * - `sys` 保存 NVIC 与 SCB 的模型状态；SysTick 与 USART 发送器的内部寄存器用 state。
 *
 * 引脚按 LQFP64 物理顺序声明（见 package.json 的描述）。VDD1 是推挽输出的高电平
 * 参考，VSS1 是低电平参考；其余 VDD/VSS 脚只参与连接与描述，不并联到内部参考。
 *
 * 固件不是 DDL 属性：统一器件工厂从 `ctx.props.firmware` 取得 `FirmwareImage`，把
 * `0x08000000` 起的绝对地址换算成 `code` 偏移后装载；JIT 直接读取装载后的模型内存。
 * `code` 保持公开只读，供测试/诊断读取实际 Flash 快照。
 */
device Stm32g431rbt6(
  clockFrequency: number default 16000000,
  hseFrequency: number default 0,
) {
  assert isFinite(clockFrequency) && clockFrequency >= 1000 && clockFrequency <= 170000000,
    "clockFrequency must be a finite value within 1000..170000000";
  assert hseFrequency == 0 || (isFinite(hseFrequency) && hseFrequency >= 1000000 && hseFrequency <= 50000000),
    "hseFrequency must be 0 (not populated) or 1..50 MHz";

  /** 128 KiB Flash：向量表在偏移 0，JIT 从这里取指；公开只读供装载快照校验。 */
  public memory code[0x20000];
  /** 22 KiB SRAM1：0x20000000–0x200057FF。 */
  memory sram[0x5800];
  /** 10 KiB CCM SRAM：0x10000000–0x100027FF。 */
  memory ccm[0x2800];
  /** 既有外设寄存器后备值；分区见 @mica-js/stm32g431rbt6-core/layout。 */
  memory periph[0x1000];
  /** SysTick、NVIC、SCB 的模型状态。 */
  memory sys[0x200];
  /** 新增外设的专属存储；每模块独立，避免挤占 periph 的低位偏移。 */
  memory analog[0x400];
  memory i2c[0x200];
  memory spi[0x200];
  memory tim[0x300];
  memory serial[0x200];
  memory exti[0x100];
  memory syscfg[0x100];
  memory dma[0x400];
  memory crc[0x20];
  memory rng[0x20];
  memory rtc[0x100];
  memory watchdog[0x40];
  memory flashState[0x100];
  /** USB 实验寄存器/PMA 备份；本轮不注册 USB 模块，仅由复位统一清零。 */
  memory usb[0x800];
  /** TIM 捕获 FIFO：16B/edge，64 项；绝对时间用 lo/hi 两部分保存。 */
  memory captureFifo[0x400];
  memory can[0x800];
  memory ucpd[0x100];
  /** 未建模外设最后写入值；按字地址散列，不再共享低 8 位别名。 */
  memory generic[0x2000];

  /** r0–r12、SP、LR：内核寄存器不参与地址映射，用 state 保存。 */
  state r0: number = 0;
  state r1: number = 0;
  state r2: number = 0;
  state r3: number = 0;
  state r4: number = 0;
  state r5: number = 0;
  state r6: number = 0;
  state r7: number = 0;
  state r8: number = 0;
  state r9: number = 0;
  state r10: number = 0;
  state r11: number = 0;
  state r12: number = 0;
  state sp: number = 0;
  state lr: number = 0xffffffff;

  /** APSR：N/Z/C/V 在 bit31..28，T 位常置 1。 */
  state apsr: number = 0x01000000;
  /** PRIMASK：1 表示屏蔽可配置优先级中断。 */
  state primask: number = 0;
  /** JIT 绑定的程序计数器（始终为偶数）。 */
  state pc: number = 0;
  /** 本块累加的指令耗时（皮秒）；越过一次节拍的量后交给 SysTick 与 USART。 */
  state pendingPs: number = 0;
  /** 当前 CPU 每周期耗时（ps）；RCC 写入后由中央刷新，指令块运行期读取。 */
  state cpuCyclePs: number = 0;
  /** 服务块累计的绝对仿真时间（ps）；供输入捕获、RTC、超时读取。 */
  state nowPs: number = 0;
  /** 当前服务节拍粒度（ps）：空闲 1 s，任一时间外设或 USART 更短时收紧。 */
  state tickPs: number = 1000000000000;
  /** 是否有需要按时间推进的外设；为 false 时指令块不必进服务块。 */
  state tickActive: bool = false;
  /** 时间外设活动槽（bit0..15，槽位见 layout 的 PeripheralSlot）。 */
  state periphActive: number = 0;
  state advancePending: number = 0;
  state advanceElapsedPs: number = 0;
  state periphDeadline0: number = 0;
  state periphDeadline1: number = 0;
  state periphDeadline2: number = 0;
  state periphDeadline3: number = 0;
  state periphDeadline4: number = 0;
  state periphDeadline5: number = 0;
  state periphDeadline6: number = 0;
  state periphDeadline7: number = 0;
  state periphDeadline8: number = 0;
  state periphDeadline9: number = 0;
  state periphDeadline10: number = 0;
  state periphDeadline11: number = 0;
  state periphDeadline12: number = 0;
  state periphDeadline13: number = 0;
  state periphDeadline14: number = 0;
  state periphDeadline15: number = 0;
  /**
   * 延迟请求位掩码（bit0=GPIO 写，bit1=IDR 读，bit2=外设写，bit3=引脚刷新）。
   * 指令块每条指令只判这一次，而不是逐个读四个标志。
   */
  state serviceMask: number = 0;
  /** 捕获 FIFO 的单调 head/tail；pending 用于无 edge 时不扫描。 */
  state captureHead: number = 0;
  state captureTail: number = 0;
  state capturePending: number = 0;
  state captureOverflow: number = 0;
  state captureResume: number = 0;
  /** 服务块要返回的 PC（节拍点指令顺序执行后的位置）。 */
  state serviceResume: number = 0;
  /**
   * HAL 时间轮询的一次性放行位。SysTick 时间事件把 CPU 转到 SERVICE_TICK 后置位，
   * 中断返回后的第一轮轮询消费它，让 HAL_Delay 能重新检查终点而不必再等一个整节拍。
   */
  state pollContinue: bool = false;
  /** 待刷新引脚意图的端口位掩码（bit0=GPIOA … bit4=GPIOF）。 */
  state gpioSync: number = 0;
  /**
   * Guest 已预计算的变化位。非零时服务块只消费该掩码并跳过寄存器重算；为零时服务块
   * 执行完整的 GPIO 寄存器写。配置写使用零值走完整路径。
   */
  state gpioPinMask: number = 0;
  /** 上一次同步时端口是否供电；供电变化会同时改变所有引脚的意图。 */
  state gpioPowered: bool = false;
  /** 延迟到服务块执行的 GPIO 写。 */
  state gpioWrite: number = 0;
  state gpioWriteAddr: number = 0;
  state gpioWriteValue: number = 0;
  state gpioWriteSize: number = 4;
  /**
   * 延迟到服务块执行的 GPIO IDR 读。IDR 需要逐脚读采样再拼字，全内联会让每条动态
   * 地址访存都带上 5 个端口的组包树；这里只记下地址、目标寄存器与宽度。
   */
  state deferRead: bool = false;
  state deferReadPort: number = 0;
  state deferReadOffset: number = 0;
  state deferReadTarget: number = 0;
  state deferReadSize: number = 4;
  state deferReadSigned: bool = false;
  state deferReadModule: number = -1;
  state deferReadAddress: number = 0;
  /**
   * 延迟到服务块执行的非 GPIO 外设写。GPIO 写仍在块内登记，服务块随后立即取走。
   */
  state deferWrite: bool = false;
  state deferWriteAddr: number = 0;
  state deferWriteValue: number = 0;
  state deferWriteSize: number = 4;
  state deferWriteModule: number = -1;
  /**
   * GPIO 配置寄存器影子（端口 0–4 × MODER/OTYPER/PUPDR/AFR0/AFR1）。引脚意图每根脚都要
   * 读这几个字，从字节内存取一次字要一次按宽度校验的加载；写寄存器时顺带同步影子，
   * 意图计算就只剩一次数组读。存储器里的字节仍是固件可见的寄存器映像。
   */
  state gpioModer0: number = 0;
  state gpioModer1: number = 0;
  state gpioModer2: number = 0;
  state gpioModer3: number = 0;
  state gpioModer4: number = 0;
  state gpioOtyper0: number = 0;
  state gpioOtyper1: number = 0;
  state gpioOtyper2: number = 0;
  state gpioOtyper3: number = 0;
  state gpioOtyper4: number = 0;
  state gpioPupdr0: number = 0;
  state gpioPupdr1: number = 0;
  state gpioPupdr2: number = 0;
  state gpioPupdr3: number = 0;
  state gpioPupdr4: number = 0;
  state gpioAfr00: number = 0;
  state gpioAfr01: number = 0;
  state gpioAfr02: number = 0;
  state gpioAfr03: number = 0;
  state gpioAfr04: number = 0;
  state gpioAfr10: number = 0;
  state gpioAfr11: number = 0;
  state gpioAfr12: number = 0;
  state gpioAfr13: number = 0;
  state gpioAfr14: number = 0;
  /** GPIO ODR：静态/动态地址的全部读写和引脚同步均访问此状态，periph 不保存副本。 */
  state gpioOdr0: number = 0;
  state gpioOdr1: number = 0;
  state gpioOdr2: number = 0;
  state gpioOdr3: number = 0;
  state gpioOdr4: number = 0;
  /** 由 GPIO 配置维护的“输出且推挽”引脚掩码；复位清空。 */
  state gpioSimpleOut0: number = 0;
  state gpioSimpleOut1: number = 0;
  state gpioSimpleOut2: number = 0;
  state gpioSimpleOut3: number = 0;
  state gpioSimpleOut4: number = 0;

  /** LCKR 已锁定引脚位（低 16 位）。 */
  state gpioLck0: number = 0;
  state gpioLck1: number = 0;
  state gpioLck2: number = 0;
  state gpioLck3: number = 0;
  state gpioLck4: number = 0;
  /** LCKK 序列阶段（低 4 位）与候选引脚掩码（bit4..19）。 */
  state gpioLckStep0: number = 0;
  state gpioLckStep1: number = 0;
  state gpioLckStep2: number = 0;
  state gpioLckStep3: number = 0;
  state gpioLckStep4: number = 0;
  /** 可能已具备中断条件；为 true 的块才扫描异常。 */
  state irqDirty: bool = false;
  /** SysTick CTRL.ENABLE 的影子，省掉每拍读 CTRL。 */
  state systickOn: bool = false;
  /** 有发送活动的 USART 位掩码（bit0=USART1，bit1=USART2，bit2=USART3）。 */
  state txMask: number = 0;
  /** SysTick 内部寄存器（不是固件可见的寄存器映像）。 */
  state systickCtrl: number = 0;
  state systickLoad: number = 0;
  state systickVal: number = 0;
  state systickCount: number = 0;
  state systickPending: number = 0;
  /** USART 发送器内部相位：活动字、剩余位时长（ps）、队列、计数、位时长（ps）。 */
  state tx1Active: number = 0;
  state tx1Remaining: number = 0;
  state tx1Queue: number = 0;
  state tx1Count: number = 0;
  state tx1Period: number = 1;
  /** 待发布的发送字节（-1 表示没有）；由服务块发出，指令块因此不含 send。 */
  state tx1Publish: number = -1;
  state tx2Active: number = 0;
  state tx2Remaining: number = 0;
  state tx2Queue: number = 0;
  state tx2Count: number = 0;
  state tx2Period: number = 1;
  state tx2Publish: number = -1;
  state tx3Active: number = 0;
  state tx3Remaining: number = 0;
  state tx3Queue: number = 0;
  state tx3Count: number = 0;
  state tx3Period: number = 1;
  state tx3Publish: number = -1;
  /** TIM/DMA 模块内部状态；由各模块的 STATE_SPECS 生成，复位值都是 0。 */
  state timCenMask: number = 0;
  state timCaptureMask: number = 0;
  state tim1LastPs: number = 0;
  state tim1AccumPs: number = 0;
  state tim1Presc: number = 0;
  state tim1Rep: number = 0;
  state tim1ArrActive: number = 0;
  state tim1PscActive: number = 0;
  state tim1Ready: number = 0;
  state tim1Ccr1Active: number = 0;
  state tim1In1: number = 0;
  state tim1Cap1: number = 0;
  state tim1Out1: number = 0;
  state tim1Ccr2Active: number = 0;
  state tim1In2: number = 0;
  state tim1Cap2: number = 0;
  state tim1Out2: number = 0;
  state tim1Ccr3Active: number = 0;
  state tim1In3: number = 0;
  state tim1Cap3: number = 0;
  state tim1Out3: number = 0;
  state tim1Ccr4Active: number = 0;
  state tim1In4: number = 0;
  state tim1Cap4: number = 0;
  state tim1Out4: number = 0;
  state tim2LastPs: number = 0;
  state tim2AccumPs: number = 0;
  state tim2Presc: number = 0;
  state tim2Rep: number = 0;
  state tim2ArrActive: number = 0;
  state tim2PscActive: number = 0;
  state tim2Ready: number = 0;
  state tim2Ccr1Active: number = 0;
  state tim2In1: number = 0;
  state tim2Cap1: number = 0;
  state tim2Out1: number = 0;
  state tim2Ccr2Active: number = 0;
  state tim2In2: number = 0;
  state tim2Cap2: number = 0;
  state tim2Out2: number = 0;
  state tim2Ccr3Active: number = 0;
  state tim2In3: number = 0;
  state tim2Cap3: number = 0;
  state tim2Out3: number = 0;
  state tim2Ccr4Active: number = 0;
  state tim2In4: number = 0;
  state tim2Cap4: number = 0;
  state tim2Out4: number = 0;
  state tim3LastPs: number = 0;
  state tim3AccumPs: number = 0;
  state tim3Presc: number = 0;
  state tim3Rep: number = 0;
  state tim3ArrActive: number = 0;
  state tim3PscActive: number = 0;
  state tim3Ready: number = 0;
  state tim3Ccr1Active: number = 0;
  state tim3In1: number = 0;
  state tim3Cap1: number = 0;
  state tim3Out1: number = 0;
  state tim3Ccr2Active: number = 0;
  state tim3In2: number = 0;
  state tim3Cap2: number = 0;
  state tim3Out2: number = 0;
  state tim3Ccr3Active: number = 0;
  state tim3In3: number = 0;
  state tim3Cap3: number = 0;
  state tim3Out3: number = 0;
  state tim3Ccr4Active: number = 0;
  state tim3In4: number = 0;
  state tim3Cap4: number = 0;
  state tim3Out4: number = 0;
  state tim4LastPs: number = 0;
  state tim4AccumPs: number = 0;
  state tim4Presc: number = 0;
  state tim4Rep: number = 0;
  state tim4ArrActive: number = 0;
  state tim4PscActive: number = 0;
  state tim4Ready: number = 0;
  state tim4Ccr1Active: number = 0;
  state tim4In1: number = 0;
  state tim4Cap1: number = 0;
  state tim4Out1: number = 0;
  state tim4Ccr2Active: number = 0;
  state tim4In2: number = 0;
  state tim4Cap2: number = 0;
  state tim4Out2: number = 0;
  state tim4Ccr3Active: number = 0;
  state tim4In3: number = 0;
  state tim4Cap3: number = 0;
  state tim4Out3: number = 0;
  state tim4Ccr4Active: number = 0;
  state tim4In4: number = 0;
  state tim4Cap4: number = 0;
  state tim4Out4: number = 0;
  state tim6LastPs: number = 0;
  state tim6AccumPs: number = 0;
  state tim6Presc: number = 0;
  state tim6Rep: number = 0;
  state tim6ArrActive: number = 0;
  state tim6PscActive: number = 0;
  state tim6Ready: number = 0;
  state tim7LastPs: number = 0;
  state tim7AccumPs: number = 0;
  state tim7Presc: number = 0;
  state tim7Rep: number = 0;
  state tim7ArrActive: number = 0;
  state tim7PscActive: number = 0;
  state tim7Ready: number = 0;
  state tim8LastPs: number = 0;
  state tim8AccumPs: number = 0;
  state tim8Presc: number = 0;
  state tim8Rep: number = 0;
  state tim8ArrActive: number = 0;
  state tim8PscActive: number = 0;
  state tim8Ready: number = 0;
  state tim8Ccr1Active: number = 0;
  state tim8In1: number = 0;
  state tim8Cap1: number = 0;
  state tim8Out1: number = 0;
  state tim8Ccr2Active: number = 0;
  state tim8In2: number = 0;
  state tim8Cap2: number = 0;
  state tim8Out2: number = 0;
  state tim8Ccr3Active: number = 0;
  state tim8In3: number = 0;
  state tim8Cap3: number = 0;
  state tim8Out3: number = 0;
  state tim8Ccr4Active: number = 0;
  state tim8In4: number = 0;
  state tim8Cap4: number = 0;
  state tim8Out4: number = 0;
  state tim15LastPs: number = 0;
  state tim15AccumPs: number = 0;
  state tim15Presc: number = 0;
  state tim15Rep: number = 0;
  state tim15ArrActive: number = 0;
  state tim15PscActive: number = 0;
  state tim15Ready: number = 0;
  state tim15Ccr1Active: number = 0;
  state tim15In1: number = 0;
  state tim15Cap1: number = 0;
  state tim15Out1: number = 0;
  state tim15Ccr2Active: number = 0;
  state tim15In2: number = 0;
  state tim15Cap2: number = 0;
  state tim15Out2: number = 0;
  state tim16LastPs: number = 0;
  state tim16AccumPs: number = 0;
  state tim16Presc: number = 0;
  state tim16Rep: number = 0;
  state tim16ArrActive: number = 0;
  state tim16PscActive: number = 0;
  state tim16Ready: number = 0;
  state tim16Ccr1Active: number = 0;
  state tim16In1: number = 0;
  state tim16Cap1: number = 0;
  state tim16Out1: number = 0;
  state tim17LastPs: number = 0;
  state tim17AccumPs: number = 0;
  state tim17Presc: number = 0;
  state tim17Rep: number = 0;
  state tim17ArrActive: number = 0;
  state tim17PscActive: number = 0;
  state tim17Ready: number = 0;
  state tim17Ccr1Active: number = 0;
  state tim17In1: number = 0;
  state tim17Cap1: number = 0;
  state tim17Out1: number = 0;
  state dmaBusy: number = 0;

  /** UART4/LPUART1 的 RCC 复位路径使用与 USART1–3 同名的 state；内部相位仍可放 periph。 */
  state tx4Active: number = 0;
  state tx4Remaining: number = 0;
  state tx4Queue: number = 0;
  state tx4Count: number = 0;
  state tx4Period: number = 1;
  state tx4Publish: number = -1;
  state tx5Active: number = 0;
  state tx5Remaining: number = 0;
  state tx5Queue: number = 0;
  state tx5Count: number = 0;
  state tx5Period: number = 1;
  state tx5Publish: number = -1;

  /** ITSTATE：高 4 位为首条件，低 4 位为掩码；0 表示不在 IT 块内。 */
  state itState: number = 0;
  /** 停机标志：遇到未实现的指令后停止推进，避免在错误路径上空转。 */
  state halted: bool = false;
  /** 未实现指令/非法访存的 PC，供适配器发布诊断。 */
  state faultPc: number = 0;

  output channel fault: number(capacity: 16);
  output channel uart1Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel uart2Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel uart3Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel uart4Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel lpuart1Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  /**
   * HAL_Delay 轮询点的放行条件：有立即服务、刚由一个 SysTick 时间事件唤醒，或当前
   * 不能安全地跳过时间（USART 正在发送 / SysTick 未使能）。后两种情况必须回到逐指令
   * 路径，否则 predicate=false 且没有时间事件会让 JIT 永久停住。
   */
  pure fn halDelayPoll() -> bool {
    return serviceMask != 0 || pollContinue || txMask != 0 || periphActive != 0 || !systickOn;
  }

  /** 一次性放行位在轮询谓词成立后由运行时消费。 */
  fn halDelayConsume() {
    pollContinue = false;
  }

  /**
   * 轮询点距离设备内部下一次时间事件还有多久。只有 SysTick 是唯一时间驱动源时才允许
   * 直接推进；USART 或任何时间外设活跃时必须继续走逐指令/服务块路径。
   */
  pure fn halDelayWaitPs() -> number {
    if !systickOn || txMask != 0 || periphActive != 0 || serviceMask != 0 || pollContinue {
      return 0;
    }
    const remaining = tickPs - pendingPs;
    return remaining > 0 ? remaining : 1;
  }

  /**
   * 在运行时推进到 SysTick 边界后更新模型状态。中断可立即取走时直接把 PC 转向
   * SERVICE_TICK；PRIMASK 屏蔽时只保留挂起位，下一次轮询仍会等待。
   */
  fn halDelayAdvance(elapsedPs: number) {
    if !systickOn || txMask != 0 || periphActive != 0 || elapsedPs <= 0 {
      return;
    }
    const remaining = tickPs - pendingPs;
    if elapsedPs < remaining {
      return;
    }

    pendingPs = 0;
    nowPs = nowPs + elapsedPs;
    systickVal = systickLoad;
    systickCount = 1;
    if (systickCtrl & 2) != 0 {
      systickPending = 1;
      irqDirty = true;
      if primask == 0 {
        pollContinue = true;
        serviceResume = pc;
        serviceMask = serviceMask | 16;
        pc = 0x20000;
      }
    }
  }

  /**
   * 外部 NRST 复位。只清模型状态与外设寄存器，不清 code/sram/ccm；随后重新从向量表
   * 取 SP/PC。GPIO 引脚意图通过一次全端口刷新撤回旧输出。
   */
  fn mcuReset() {
    const resetCount = load32le(sys, 0x1fc);
    // RCC_BDCR 属备份域：NRST 与 SYSRESETREQ 一样保留 LSE/RTC 选择与 RTCEN。
    const backupDomain = load32le(periph, 0x90);
    r0 = 0; r1 = 0; r2 = 0; r3 = 0; r4 = 0; r5 = 0; r6 = 0; r7 = 0;
    r8 = 0; r9 = 0; r10 = 0; r11 = 0; r12 = 0;
    sp = 0;
    lr = 0xffffffff;
    apsr = 0x01000000;
    primask = 0;
    pc = 0;
    pendingPs = 0;
    cpuCyclePs = round(1000000000000 / clockFrequency);
    nowPs = 0;
    tickPs = 1000000000000;
    tickActive = false;
    periphActive = 0;
    advancePending = 0;
    advanceElapsedPs = 0;
    periphDeadline0 = 0; periphDeadline1 = 0; periphDeadline2 = 0; periphDeadline3 = 0;
    periphDeadline4 = 0; periphDeadline5 = 0; periphDeadline6 = 0; periphDeadline7 = 0;
    periphDeadline8 = 0; periphDeadline9 = 0; periphDeadline10 = 0; periphDeadline11 = 0;
    periphDeadline12 = 0; periphDeadline13 = 0; periphDeadline14 = 0; periphDeadline15 = 0;
    serviceMask = 0;
    captureHead = 0;
    captureTail = 0;
    capturePending = 0;
    captureOverflow = 0;
    captureResume = 0;
    serviceResume = 0;
    pollContinue = false;
    gpioSync = 0;
    gpioPinMask = 0;
    gpioPowered = false;
    gpioWrite = 0;
    gpioWriteAddr = 0;
    gpioWriteValue = 0;
    gpioWriteSize = 4;
    deferRead = false;
    deferReadPort = 0;
    deferReadOffset = 0;
    deferReadTarget = 0;
    deferReadSize = 4;
    deferReadSigned = false;
    deferReadModule = -1;
    deferReadAddress = 0;
    deferWrite = false;
    deferWriteAddr = 0;
    deferWriteValue = 0;
    deferWriteSize = 4;
    deferWriteModule = -1;
    gpioModer0 = 0; gpioModer1 = 0; gpioModer2 = 0; gpioModer3 = 0; gpioModer4 = 0;
    gpioOtyper0 = 0; gpioOtyper1 = 0; gpioOtyper2 = 0; gpioOtyper3 = 0; gpioOtyper4 = 0;
    gpioPupdr0 = 0; gpioPupdr1 = 0; gpioPupdr2 = 0; gpioPupdr3 = 0; gpioPupdr4 = 0;
    gpioAfr00 = 0; gpioAfr01 = 0; gpioAfr02 = 0; gpioAfr03 = 0; gpioAfr04 = 0;
    gpioAfr10 = 0; gpioAfr11 = 0; gpioAfr12 = 0; gpioAfr13 = 0; gpioAfr14 = 0;
    gpioOdr0 = 0; gpioOdr1 = 0; gpioOdr2 = 0; gpioOdr3 = 0; gpioOdr4 = 0;
    gpioSimpleOut0 = 0; gpioSimpleOut1 = 0; gpioSimpleOut2 = 0; gpioSimpleOut3 = 0; gpioSimpleOut4 = 0;
    gpioLck0 = 0; gpioLck1 = 0; gpioLck2 = 0; gpioLck3 = 0; gpioLck4 = 0;
    gpioLckStep0 = 0; gpioLckStep1 = 0; gpioLckStep2 = 0; gpioLckStep3 = 0; gpioLckStep4 = 0;
    irqDirty = false;
    systickOn = false;
    txMask = 0;
    systickCtrl = 0;
    systickLoad = 0;
    systickVal = 0;
    systickCount = 0;
    systickPending = 0;
    tx1Active = 0; tx1Remaining = 0; tx1Queue = 0; tx1Count = 0; tx1Period = 1; tx1Publish = -1;
    tx2Active = 0; tx2Remaining = 0; tx2Queue = 0; tx2Count = 0; tx2Period = 1; tx2Publish = -1;
    tx3Active = 0; tx3Remaining = 0; tx3Queue = 0; tx3Count = 0; tx3Period = 1; tx3Publish = -1;
    tx4Active = 0; tx4Remaining = 0; tx4Queue = 0; tx4Count = 0; tx4Period = 1; tx4Publish = -1;
    tx5Active = 0; tx5Remaining = 0; tx5Queue = 0; tx5Count = 0; tx5Period = 1; tx5Publish = -1;
    itState = 0;
    halted = false;
    faultPc = 0;

    // TIM/DMA 模块 state（STATE_SPECS 的复位值）。
    timCenMask = 0;
    timCaptureMask = 0;
    tim1LastPs = 0;
    tim1AccumPs = 0;
    tim1Presc = 0;
    tim1Rep = 0;
    tim1ArrActive = 0;
    tim1PscActive = 0;
    tim1Ready = 0;
    tim1Ccr1Active = 0;
    tim1In1 = 0;
    tim1Cap1 = 0;
    tim1Out1 = 0;
    tim1Ccr2Active = 0;
    tim1In2 = 0;
    tim1Cap2 = 0;
    tim1Out2 = 0;
    tim1Ccr3Active = 0;
    tim1In3 = 0;
    tim1Cap3 = 0;
    tim1Out3 = 0;
    tim1Ccr4Active = 0;
    tim1In4 = 0;
    tim1Cap4 = 0;
    tim1Out4 = 0;
    tim2LastPs = 0;
    tim2AccumPs = 0;
    tim2Presc = 0;
    tim2Rep = 0;
    tim2ArrActive = 0;
    tim2PscActive = 0;
    tim2Ready = 0;
    tim2Ccr1Active = 0;
    tim2In1 = 0;
    tim2Cap1 = 0;
    tim2Out1 = 0;
    tim2Ccr2Active = 0;
    tim2In2 = 0;
    tim2Cap2 = 0;
    tim2Out2 = 0;
    tim2Ccr3Active = 0;
    tim2In3 = 0;
    tim2Cap3 = 0;
    tim2Out3 = 0;
    tim2Ccr4Active = 0;
    tim2In4 = 0;
    tim2Cap4 = 0;
    tim2Out4 = 0;
    tim3LastPs = 0;
    tim3AccumPs = 0;
    tim3Presc = 0;
    tim3Rep = 0;
    tim3ArrActive = 0;
    tim3PscActive = 0;
    tim3Ready = 0;
    tim3Ccr1Active = 0;
    tim3In1 = 0;
    tim3Cap1 = 0;
    tim3Out1 = 0;
    tim3Ccr2Active = 0;
    tim3In2 = 0;
    tim3Cap2 = 0;
    tim3Out2 = 0;
    tim3Ccr3Active = 0;
    tim3In3 = 0;
    tim3Cap3 = 0;
    tim3Out3 = 0;
    tim3Ccr4Active = 0;
    tim3In4 = 0;
    tim3Cap4 = 0;
    tim3Out4 = 0;
    tim4LastPs = 0;
    tim4AccumPs = 0;
    tim4Presc = 0;
    tim4Rep = 0;
    tim4ArrActive = 0;
    tim4PscActive = 0;
    tim4Ready = 0;
    tim4Ccr1Active = 0;
    tim4In1 = 0;
    tim4Cap1 = 0;
    tim4Out1 = 0;
    tim4Ccr2Active = 0;
    tim4In2 = 0;
    tim4Cap2 = 0;
    tim4Out2 = 0;
    tim4Ccr3Active = 0;
    tim4In3 = 0;
    tim4Cap3 = 0;
    tim4Out3 = 0;
    tim4Ccr4Active = 0;
    tim4In4 = 0;
    tim4Cap4 = 0;
    tim4Out4 = 0;
    tim6LastPs = 0;
    tim6AccumPs = 0;
    tim6Presc = 0;
    tim6Rep = 0;
    tim6ArrActive = 0;
    tim6PscActive = 0;
    tim6Ready = 0;
    tim7LastPs = 0;
    tim7AccumPs = 0;
    tim7Presc = 0;
    tim7Rep = 0;
    tim7ArrActive = 0;
    tim7PscActive = 0;
    tim7Ready = 0;
    tim8LastPs = 0;
    tim8AccumPs = 0;
    tim8Presc = 0;
    tim8Rep = 0;
    tim8ArrActive = 0;
    tim8PscActive = 0;
    tim8Ready = 0;
    tim8Ccr1Active = 0;
    tim8In1 = 0;
    tim8Cap1 = 0;
    tim8Out1 = 0;
    tim8Ccr2Active = 0;
    tim8In2 = 0;
    tim8Cap2 = 0;
    tim8Out2 = 0;
    tim8Ccr3Active = 0;
    tim8In3 = 0;
    tim8Cap3 = 0;
    tim8Out3 = 0;
    tim8Ccr4Active = 0;
    tim8In4 = 0;
    tim8Cap4 = 0;
    tim8Out4 = 0;
    tim15LastPs = 0;
    tim15AccumPs = 0;
    tim15Presc = 0;
    tim15Rep = 0;
    tim15ArrActive = 0;
    tim15PscActive = 0;
    tim15Ready = 0;
    tim15Ccr1Active = 0;
    tim15In1 = 0;
    tim15Cap1 = 0;
    tim15Out1 = 0;
    tim15Ccr2Active = 0;
    tim15In2 = 0;
    tim15Cap2 = 0;
    tim15Out2 = 0;
    tim16LastPs = 0;
    tim16AccumPs = 0;
    tim16Presc = 0;
    tim16Rep = 0;
    tim16ArrActive = 0;
    tim16PscActive = 0;
    tim16Ready = 0;
    tim16Ccr1Active = 0;
    tim16In1 = 0;
    tim16Cap1 = 0;
    tim16Out1 = 0;
    tim17LastPs = 0;
    tim17AccumPs = 0;
    tim17Presc = 0;
    tim17Rep = 0;
    tim17ArrActive = 0;
    tim17PscActive = 0;
    tim17Ready = 0;
    tim17Ccr1Active = 0;
    tim17In1 = 0;
    tim17Cap1 = 0;
    tim17Out1 = 0;
    dmaBusy = 0;

    let at = 0;
    while at < 0x1000 { store8(periph, at, 0); at = at + 1; }
    store32le(periph, 0x90, backupDomain);
    at = 0;
    while at < 0x200 { store8(sys, at, 0); at = at + 1; }
    at = 0;
    while at < 0x400 { store8(analog, at, 0); at = at + 1; }
    at = 0;
    while at < 0x200 { store8(i2c, at, 0); at = at + 1; }
    at = 0;
    while at < 0x200 { store8(spi, at, 0); at = at + 1; }
    at = 0;
    while at < 0x300 { store8(tim, at, 0); at = at + 1; }
    at = 0;
    while at < 0x200 { store8(serial, at, 0); at = at + 1; }
    at = 0;
    while at < 0x100 { store8(exti, at, 0); at = at + 1; }
    at = 0;
    while at < 0x100 { store8(syscfg, at, 0); at = at + 1; }
    at = 0;
    while at < 0x400 { store8(dma, at, 0); at = at + 1; }
    at = 0;
    while at < 0x20 { store8(crc, at, 0); at = at + 1; }
    at = 0;
    while at < 0x20 { store8(rng, at, 0); at = at + 1; }
    // RTC 寄存器/日历在备份域，NRST 与 SYSRESETREQ 都保留。
    at = 0;
    while at < 0x40 { store8(watchdog, at, 0); at = at + 1; }
    // 选项字节/写保护跨 NRST 保留；标记 2 让 flash 模块下次访问只复位控制器寄存器。
    store32le(flashState, 0xfc, 0x464c5352);
    at = 0;
    while at < 0x2000 { store8(generic, at, 0); at = at + 1; }
    at = 0;
    while at < 0x800 { store8(usb, at, 0); at = at + 1; }
    at = 0;
    while at < 0x400 { store8(captureFifo, at, 0); at = at + 1; }
    at = 0;
    while at < 0x800 { store8(can, at, 0); at = at + 1; }
    at = 0;
    while at < 0x100 { store8(ucpd, at, 0); at = at + 1; }

    sp = load32le(code, 0);
    lr = 0xffffffff;
    pc = load32le(code, 4) & 0xfffffffe;
    store32le(sys, 0x1f8, 1);
    store32le(sys, 0x1fc, resetCount + 1);
    gpioSync = 31;
    serviceMask = serviceMask | 8;
  }


  /** WFI：已有 service 或 pending IRQ 时不要 park。 */
  pure fn cpuWfiPoll() -> bool {
    return serviceMask != 0 || irqDirty;
  }

  /** WFE：event、service 或 pending IRQ 任一成立即可唤醒。 */
  pure fn cpuWfePoll() -> bool {
    return load32le(sys, 0x14c) != 0 || serviceMask != 0 || irqDirty;
  }

  /** 到下一个 service 节拍的时间；0 表示 park 到依赖变化。 */
  pure fn cpuWaitWaitPs() -> number {
    if !tickActive || serviceMask != 0 || irqDirty {
      return 0;
    }
    const remaining = tickPs - pendingPs;
    return remaining > 0 ? remaining : 1;
  }

  /**
   * polling deadline 到达后：只推进时间并进入现有 SERVICE_TICK。
   *
   * `serviceResume` 必须是等待指令 PC，而不是 `pc + 2`：没有真实 IRQ 时
   * SERVICE_TICK/DISPATCH 回到等待指令继续等；`waitNext` 只在异常被真正取走时
   * 作为异常栈返回地址（由中央的 `waitExceptionReturnPc` 读取）。
   */
  fn cpuWaitAdvance(elapsedPs: number) {
    if elapsedPs <= 0 {
      return;
    }
    pendingPs = pendingPs + elapsedPs;
    store32le(sys, 0x150, 1);       // waitActive
    store32le(sys, 0x154, pc);      // waitPc
    store32le(sys, 0x158, pc + 2);  // waitNext（WFI/WFE 都是 2 字节）
    serviceResume = pc;
    pc = 0x20000;
  }

  /**
   * 复位：从向量表取初始 SP 与复位入口。入口地址的 bit0 是 Thumb 状态位，进入 JIT
   * 前清掉；固件为空时 PC=0，执行全零的 `lsls r0,r0,#0` 直到第一个有效映像写入。
   */
  process start {
    sp = load32le(code, 0);
    lr = 0xffffffff;
    pc = load32le(code, 4) & 0xfffffffe;
    cpuCyclePs = round(1000000000000 / clockFrequency);
  }

  pin VBAT;
  pin PC13(low: 0.8, high: 2.0);
  pin PC14(low: 0.8, high: 2.0);
  pin PC15(low: 0.8, high: 2.0);
  pin PF0(low: 0.8, high: 2.0);
  pin PF1(low: 0.8, high: 2.0);
  pin NRST(low: 0.8, high: 2.0);
  pin PC0(low: 0.8, high: 2.0);
  pin PC1(low: 0.8, high: 2.0);
  pin PC2(low: 0.8, high: 2.0);
  pin PC3(low: 0.8, high: 2.0);
  pin PA0(low: 0.8, high: 2.0);
  pin PA1(low: 0.8, high: 2.0);
  pin PA2(low: 0.8, high: 2.0);
  pin VSS1;
  pin VDD1;
  pin PA3(low: 0.8, high: 2.0);
  pin PA4(low: 0.8, high: 2.0);
  pin PA5(low: 0.8, high: 2.0);
  pin PA6(low: 0.8, high: 2.0);
  pin PA7(low: 0.8, high: 2.0);
  pin PC4(low: 0.8, high: 2.0);
  pin PC5(low: 0.8, high: 2.0);
  pin PB0(low: 0.8, high: 2.0);
  pin PB1(low: 0.8, high: 2.0);
  pin PB2(low: 0.8, high: 2.0);
  pin VSSA;
  pin VREFP;
  pin VDDA;
  pin PB10(low: 0.8, high: 2.0);
  pin VSS2;
  pin VDD2;
  pin PB11(low: 0.8, high: 2.0);
  pin PB12(low: 0.8, high: 2.0);
  pin PB13(low: 0.8, high: 2.0);
  pin PB14(low: 0.8, high: 2.0);
  pin PB15(low: 0.8, high: 2.0);
  pin PC6(low: 0.8, high: 2.0);
  pin PC7(low: 0.8, high: 2.0);
  pin PC8(low: 0.8, high: 2.0);
  pin PC9(low: 0.8, high: 2.0);
  pin PA8(low: 0.8, high: 2.0);
  pin PA9(low: 0.8, high: 2.0);
  pin PA10(low: 0.8, high: 2.0);
  pin PA11(low: 0.8, high: 2.0);
  pin PA12(low: 0.8, high: 2.0);
  pin VSS3;
  pin VDD3;
  pin PA13(low: 0.8, high: 2.0);
  pin PA14(low: 0.8, high: 2.0);
  pin PA15(low: 0.8, high: 2.0);
  pin PC10(low: 0.8, high: 2.0);
  pin PC11(low: 0.8, high: 2.0);
  pin PC12(low: 0.8, high: 2.0);
  pin PD2(low: 0.8, high: 2.0);
  pin PB3(low: 0.8, high: 2.0);
  pin PB4(low: 0.8, high: 2.0);
  pin PB5(low: 0.8, high: 2.0);
  pin PB6(low: 0.8, high: 2.0);
  pin PB7(low: 0.8, high: 2.0);
  pin PB8(low: 0.8, high: 2.0);
  pin PB9(low: 0.8, high: 2.0);
  pin VSS4;
  pin VDD4;

  /**
   * NRST 低电平期间保持 halted，JIT 不再执行指令；释放沿执行完整 MCU 复位并从向量表
   * 重新取指。未接 NRST 时 sample.level 不是 Logic.low，不会误触发。
   */
  // BEGIN GENERATED TIM CAPTURE GATES (render-capture-gates.ts)
  pure fn captureArmed(pinId: number) -> bool {
    if pinId == 0 {
      return (load32le(periph, 0x4c) & 1) != 0
        && (load32le(periph, 0x2c) & 1) == 0
        && (load32le(periph, 0x58) & 1) != 0
        && (load32le(periph, 0x38) & 1) == 0
        && (load32le(tim, 0x48 + 0x00) & 1) != 0
        && ((load32le(tim, 0x48 + 0x18) >> 0) & 3) == 1
        && (load32le(tim, 0x48 + 0x20) & 1) != 0
        && ((gpioModer0 >> 30) & 3) == 2
        && ((gpioAfr10 >> 28) & 0xf) == 1;
    } else if pinId == 1 {
      return (load32le(periph, 0x4c) & 2) != 0
        && (load32le(periph, 0x2c) & 2) == 0
        && (load32le(periph, 0x58) & 2) != 0
        && (load32le(periph, 0x38) & 2) == 0
        && (load32le(tim, 0x90 + 0x00) & 1) != 0
        && ((load32le(tim, 0x90 + 0x18) >> 0) & 3) == 1
        && (load32le(tim, 0x90 + 0x20) & 1) != 0
        && ((gpioModer1 >> 8) & 3) == 2
        && ((gpioAfr01 >> 16) & 0xf) == 2;
    } else {
      return false;
    }
  }
  // END GENERATED TIM CAPTURE GATES

  /** 把一条真实边沿写入 16B FIFO；满时只发一次 fault，overflow 后拒绝入队。 */
  fn pushCapture(pinId: number, high: bool) {
    if captureOverflow != 0 || !captureArmed(pinId) || halted {
      return;
    }
    if captureTail - captureHead >= 64 {
      captureOverflow = 1;
      faultPc = 0xffffffff;
      halted = true;
      fault.send(0xffffffff);
      return;
    }
    const at = (captureTail % 64) * 16;
    const t = now();
    store32le(captureFifo, at, t % 4294967296);
    store32le(captureFifo, at + 4, floor(t / 4294967296));
    store8(captureFifo, at + 8, pinId);
    if high { store8(captureFifo, at + 9, 1); }
    else { store8(captureFifo, at + 9, 0); }
    captureTail = captureTail + 1;
    capturePending = 1;
    serviceMask = serviceMask | 32;
    if pc != 0x20008 {
      captureResume = pc;
      pc = 0x20008;
    }
  }

  reaction capturePA15 on PA15.sample.level as (previous, next) {
    if previous != Logic.unknown && next != previous && next != Logic.unknown {
      pushCapture(0, next == Logic.high);
    }
  }

  reaction capturePB4 on PB4.sample.level as (previous, next) {
    if previous != Logic.unknown && next != previous && next != Logic.unknown {
      pushCapture(1, next == Logic.high);
    }
  }

  reaction nrstRelease on NRST.sample.level as (previous, next) {
    if next == Logic.low {
      halted = true;
    } else if previous == Logic.low && next != Logic.low {
      mcuReset();
    }
  }
}
