/**
 * IAP15F2K61S2 的器件模型：存储器、状态与引脚。
 *
 * 行为不写在 DDL 里：8051 内核与外设都在 `kernel/` 与 `peripherals/` 中生成 IR，DDL 只声明
 * 资源。外设不可见的内部实现状态放在 `periph` 里，由各外设模块按 `peripherals/layout.ts`
 * 的分区使用。
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

  /** 程序计数器；JIT 绑定到这条 state。 */
  state pc: number = 0;
  /**
   * 已记过时间、但还没交给外设的皮秒数（「待推进时间」）。
   *
   * 每条指令在末尾把自己的时钟数累加到这里；节拍点与服务块把它一次性交给外设并清零。
   * 用累加而不是读宿主时钟，指令块才能只含纯算术、进入直接后端。
   */
  state clockPs: number = 0;

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
