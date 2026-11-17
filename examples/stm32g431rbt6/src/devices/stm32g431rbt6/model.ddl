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
 * 引脚按 LQFP64 物理顺序声明（见 device.json 的脚注说明）。VDD1 是推挽输出的高电平
 * 参考，VSS1 是低电平参考；其余 VDD/VSS 脚只参与连接与描述，不并联到内部参考。
 */
device Stm32g431rbt6(firmware: bytes default bytes[], clockFrequency: number default 16000000) {
  assert isFinite(clockFrequency) && clockFrequency >= 1000 && clockFrequency <= 170000000,
    "clockFrequency must be a finite value within 1000..170000000";

  /** 128 KiB Flash：向量表在偏移 0，JIT 从这里取指。 */
  memory code[0x20000];
  /** 22 KiB SRAM1：0x20000000–0x200057FF。 */
  memory sram[0x5800];
  /** 10 KiB CCM SRAM：0x10000000–0x100027FF。 */
  memory ccm[0x2800];
  /** 外设寄存器后备值；分区见 @mica-js/stm32g431rbt6-core/layout。 */
  memory periph[0x1000];
  /** SysTick、NVIC、SCB 的模型状态。 */
  memory sys[0x200];

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
  /** 当前服务节拍粒度（ps）：空闲 1 s，SysTick 周期或 USART 位时长更短时收紧。 */
  state tickPs: number = 1000000000000;
  /** 是否有需要按时间推进的外设；为 false 时指令块不必进服务块。 */
  state tickActive: bool = false;
  /**
   * 延迟请求位掩码（bit0=GPIO 写，bit1=IDR 读，bit2=外设写，bit3=引脚刷新）。
   * 指令块每条指令只判这一次，而不是逐个读四个标志。
   */
  state serviceMask: number = 0;
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
  /**
   * 延迟到服务块执行的非 GPIO 外设写。GPIO 写仍在块内登记，服务块随后立即取走。
   */
  state deferWrite: bool = false;
  state deferWriteAddr: number = 0;
  state deferWriteValue: number = 0;
  state deferWriteSize: number = 4;
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

  /**
   * HAL_Delay 轮询点的放行条件：有立即服务、刚由一个 SysTick 时间事件唤醒，或当前
   * 不能安全地跳过时间（USART 正在发送 / SysTick 未使能）。后两种情况必须回到逐指令
   * 路径，否则 predicate=false 且没有时间事件会让 JIT 永久停住。
   */
  pure fn halDelayPoll() -> bool {
    return serviceMask != 0 || pollContinue || txMask != 0 || !systickOn;
  }

  /** 一次性放行位在轮询谓词成立后由运行时消费。 */
  fn halDelayConsume() {
    pollContinue = false;
  }

  /**
   * 轮询点距离设备内部下一次时间事件还有多久。只有 SysTick 是唯一时间驱动源时才允许
   * 直接推进；USART 发送中必须继续走逐指令路径，保持位时序。
   */
  pure fn halDelayWaitPs() -> number {
    if !systickOn || txMask != 0 || serviceMask != 0 || pollContinue {
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
    if !systickOn || txMask != 0 || elapsedPs <= 0 {
      return;
    }
    const remaining = tickPs - pendingPs;
    if elapsedPs < remaining {
      return;
    }

    pendingPs = 0;
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
   * 复位：从向量表取初始 SP 与复位入口。入口地址的 bit0 是 Thumb 状态位，进入 JIT
   * 前清掉；固件为空时 PC=0，执行全零的 `lsls r0,r0,#0` 直到第一个有效映像写入。
   */
  process start {
    sp = load32le(code, 0);
    lr = 0xffffffff;
    pc = load32le(code, 4) & 0xfffffffe;
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
}
