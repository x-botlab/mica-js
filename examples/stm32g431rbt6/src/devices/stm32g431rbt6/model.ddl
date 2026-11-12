/**
 * STM32G431RBT6（LQFP64，Arm Cortex-M4F）的器件模型。
 *
 * 行为不写在 DDL 里：Thumb/Thumb-2 指令、GPIO、RCC、SysTick、NVIC 与 USART 都由
 * `core/` 在翻译期生成 IR。DDL 只声明资源与复位值：
 * - `code` 是 128 KiB Flash 的字节映像，JIT 从它的 0x00000–0x1FFFF 偏移取指；
 * - `sram` 是 22 KiB SRAM1（0x20000000），`ccm` 是 10 KiB CCM SRAM（0x10000000）；
 * - `r0`–`r12`、`sp`、`lr` 用 state 保存（寄存器不可寻址，state 比字节内存快），
 *   PC 单独作为 JIT 绑定的 state；
 * - `periph` 保存外设寄存器的不可见后备值，分区见 `core/layout.ts`；
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
  /** 外设寄存器后备值；分区见 core/layout.ts。 */
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
  /** 当前服务节拍粒度（ps）：空闲 64 µs，SysTick 周期或 USART 位时长更短时收紧。 */
  state tickPs: number = 64000000;
  /** 是否有需要按时间推进的外设；为 false 时指令块不必进服务块。 */
  state tickActive: bool = false;
  /** 服务块要返回的 PC（节拍点指令顺序执行后的位置）。 */
  state serviceResume: number = 0;
  /** 待刷新引脚意图的端口位掩码（bit0=GPIOA … bit4=GPIOF）。 */
  state gpioSync: number = 0;
  /** 延迟到服务块执行的 GPIO 写。 */
  state gpioWrite: number = 0;
  state gpioWriteAddr: number = 0;
  state gpioWriteValue: number = 0;
  state gpioWriteSize: number = 4;
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
