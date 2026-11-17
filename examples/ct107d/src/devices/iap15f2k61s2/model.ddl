/**
 * IAP15F2K61S2 的器件模型：存储器、状态与引脚。
 *
 * DDL 声明资源与引脚级响应：存储器、状态、通道，以及 UART1 在 P3_0 上的起始位观察
 * （`uart1RxHigh` / `uart1RxEdge`）。8051 内核与外设的时序行为仍在 `kernel/` 与
 * `peripherals/` 中生成 IR；外设不可见的内部实现状态放在 `periph` 里，由各外设模块按
 * `peripherals/layout.ts` 的分区使用。
 */
device Iap15f2k61s2(firmware: bytes default bytes[], clockFrequency: number default 11059200) {
  assert isSafeInteger(clockFrequency)
      && clockFrequency >= 1_000_000
      && clockFrequency <= 40_000_000,
    "clockFrequency must be an integer within 1000000..40000000";

  /** 程序存储器：60 KiB 代码空间，JIT 从这里取指。 */
  memory code[0x10000];
  /** 内部 RAM：低 128 字节直接/间接寻址，高 128 字节仅间接寻址（含堆栈）。 */
  memory iram[0x100];
  /** SFR 锁存器：下标等于 SFR 地址的低 7 位。 */
  memory sfr[0x80];
  /** 片内扩展 RAM：MOVX 访问，1792 字节。 */
  memory xram[0x700];
  /** 外设内部状态：计数余量、移位寄存器、相位与中断栈。 */
  memory periph[0x100];
  /** 片内 EEPROM（Data Flash）：IAP 读写，1 KiB。 */
  memory flash[0x400];

  /** 串口 1 的线上字节流：每个完整帧发布一条单字节消息。 */
  output channel uart1Tx: bytes(maxLength: 1, capacity: 16, overflow: Overflow.drop_oldest);
  /** 串口 1 实际写入接收缓冲的字节：每个完整帧发布一条单字节消息。 */
  output channel uart1Rx: bytes(maxLength: 1, capacity: 16, overflow: Overflow.drop_oldest);

  /** 程序计数器；JIT 绑定到这条 state。 */
  state pc: number = 0;
  /**
   * 已记过时间、但还没交给外设的皮秒数（「待推进时间」）。
   *
   * 每条指令在末尾把自己的时钟数累加到这里；服务块把它一次性交给外设并清零。
   * 用累加而不是读宿主时钟，指令块才能只含纯算术、进入直接后端。
   */
  state clockPs: number = 0;
  /**
   * 距离下一次必须进入服务块的安全时间（整数 ps，相对上次统一结算）。
   *
   * - 初始 `0`：尚未结算；一旦有活跃外设，下一个节拍点会做一次保守服务；
   * - `1`：必须在下一个节拍点进入服务（保守回退或配置刚变化）；
   * - 其它正数：`clockPs` 达到该值时才需要服务；
   * - 无定时需求时结算写入内部哨兵 `1e15`（不是 `0`），避免每个节拍点再判空。
   *
   * 使用 number state 而不是 32 位 periph 槽：1 MHz、12T、16 位定时器的最长期限为
   * 65536 × 12 × 10^6 = 786432000000 ps，超出 u32，但在安全整数范围内。
   */
  state serviceDeadline: number = 0;
  /** 各定时器最近一次结算后算出的下一次可观察事件期限；由 timer 外设维护。 */
  state t0Deadline: number = 0;
  state t1Deadline: number = 0;
  state t2Deadline: number = 0;

  /** UART1 默认 RXD（P3_0）的边沿观察开关；禁用时 derived 保持高，不产生候选沿。 */
  state uart1EdgeEnabled: bool = false;
  /** P3_0 已出现高→非高候选沿，等待内核消费。 */
  state uart1Wake: bool = false;
  /** 最近一次候选沿的仿真时刻（ps）。 */
  state uart1EdgeAt: number = 0;
  /**
   * 当前候选沿是否可作为起始位。每次接受候选沿后置否，线上回到高电平后才恢复；
   * 因此一段连续低电平只能开一帧，下一帧必须来自新的高→低电平。
   */
  state uart1EdgeArmed: bool = true;
  /** UART1 接收配置快照：bit0-1 有效模式、bit2-3 路由、bit4 REN；初值与复位一致。 */
  state uart1RxConfig: number = 0;

  /** 未知电平按低：只有确定的高电平记作高；禁用时保持高。 */
  derived uart1RxHigh: bool = !uart1EdgeEnabled || P3_0.sample.level == Logic.high;

  /**
   * P3_0 高→非高候选沿：记录时刻；只有仍然保有资格的候选才置唤醒。
   *
   * 唤醒同时消费资格，保证同一段低电平不会被重复当成起始位。
   */
  reaction uart1RxEdge on uart1RxHigh as (previous, current) {
    if previous && !current {
      uart1EdgeAt = now();
      if uart1EdgeArmed {
        uart1Wake = true;
        uart1EdgeArmed = false;
      }
    }
    if !previous && current {
      uart1EdgeArmed = true;
    }
  }

  /**
   * 复位值：SP=07H、PCON=30H、AUXR=01H、SPCTL=04H、P0–P3 锁存全 1（准双向、释放）。
   * 其余 SFR 与 `periph` 按零初始化；启动过程先于 JIT 的第一条指令执行。
   */
  process start {
    store8(sfr, 0x00, 0xff);
    store8(sfr, 0x01, 0x07);
    store8(sfr, 0x07, 0x30);
    store8(sfr, 0x0e, 0x01);
    store8(sfr, 0x10, 0xff);
    store8(sfr, 0x20, 0xff);
    store8(sfr, 0x30, 0xff);
    store8(sfr, 0x4e, 0x04);
  }
  pin P0_0(low: 1.5, high: 3.5);
  pin P0_1(low: 1.5, high: 3.5);
  pin P0_2(low: 1.5, high: 3.5);
  pin P0_3(low: 1.5, high: 3.5);
  pin P0_4(low: 1.5, high: 3.5);
  pin P0_5(low: 1.5, high: 3.5);
  pin P0_6(low: 1.5, high: 3.5);
  pin P0_7(low: 1.5, high: 3.5);
  pin P1_0(low: 1.5, high: 3.5);
  pin P1_1(low: 1.5, high: 3.5);
  pin P1_2(low: 1.5, high: 3.5);
  pin P1_3(low: 1.5, high: 3.5);
  pin P1_4(low: 1.5, high: 3.5);
  pin P1_5(low: 1.5, high: 3.5);
  pin P1_6(low: 1.5, high: 3.5);
  pin P1_7(low: 1.5, high: 3.5);
  pin P2_0(low: 1.5, high: 3.5);
  pin P2_1(low: 1.5, high: 3.5);
  pin P2_2(low: 1.5, high: 3.5);
  pin P2_3(low: 1.5, high: 3.5);
  pin P2_4(low: 1.5, high: 3.5);
  pin P2_5(low: 1.5, high: 3.5);
  pin P2_6(low: 1.5, high: 3.5);
  pin P2_7(low: 1.5, high: 3.5);
  pin P3_0(low: 1.5, high: 3.5);
  pin P3_1(low: 1.5, high: 3.5);
  pin P3_2(low: 1.5, high: 3.5);
  pin P3_3(low: 1.5, high: 3.5);
  pin P3_4(low: 1.5, high: 3.5);
  pin P3_5(low: 1.5, high: 3.5);
  pin P3_6(low: 1.5, high: 3.5);
  pin P3_7(low: 1.5, high: 3.5);

  /** 供电与地：装配必须把它们接到固定电位网络，推挽输出才有参考。 */
  pin VCC;
  pin GND;
}
