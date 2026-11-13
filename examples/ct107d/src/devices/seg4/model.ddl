/**
 * 四位七段数码管（CT107D 的 DS1/DS2）。
 *
 * 电气：每段阳极（a–g、dp）到每一位的公共端（com1–com4）之间是一段等效串联电阻，
 * 与 `blue-led` 相同，平台只提供线性电阻意图，所以没有正向压降、反向截止与发光效率。
 * 8 段 × 4 位共 32 条支路。
 *
 * 极性：`commonAnode` 为 false（默认）时是共阴管——公共端低电平选中该位、段脚高电平
 * 点亮；为 true 时是共阳管——公共端高电平选中、段脚低电平点亮。两种极性下 `digit1`–
 * `digit4` 都按「点亮的段」编码，因此适配器、话题与 UI 不随极性变化。
 *
 * 显示：真实数码管靠多路扫描刷新，人眼看到的是各段亮度的积分。模型不做时间积分，而是把
 * 每一位最近一次被选中时的段码保存下来——这就是「扫描结束后屏上留下的内容」。选中期间
 * 段脚变化会继续跟随（等价于先选位、后写段码也能显示），取消选中（释放或反极性）后只保持，
 * 不清屏；选中期间没有任何段点亮会把该位保存为 0（熄灭）。
 *
 * 理想化：零传播延迟；不模拟亮度、余辉、扫描占空比与人眼积分；段脚不需要外部限流电阻
 * 时可直接接驱动，外部电阻可按 blue-led 的做法并入 `forwardResistance`。
 */
device Seg4(
  forwardResistance: number default 500,
  commonAnode: bool default false
) {
  assert isFinite(forwardResistance)
      && forwardResistance >= 0.001
      && forwardResistance <= 1_000_000_000,
    "forwardResistance must be a finite ohm value within 0.001..1000000000";

  pin a(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  pin b(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  pin c(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  pin d(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  pin e(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  pin f(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  pin g(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  pin dp(low: 0.8, high: 2.0) = [
    resistor(to: com1, resistance: forwardResistance),
    resistor(to: com2, resistance: forwardResistance),
    resistor(to: com3, resistance: forwardResistance),
    resistor(to: com4, resistance: forwardResistance)
  ];
  // 公共端的判定阈值高于普通逻辑脚：线性模型没有正向压降，选中位的公共端会被导通的
  // 段路径拉动（共阴：8 段全亮时约 1.4 V；共阳：8 段全亮时约 4.4 V），而未选中的位由
  // 驱动器拉到对侧电源轨（共阴 3.5 V 以上、共阳 0.6 V 以下），抬高后的阈值才能把这两态
  // 分开。
  pin com1(low: 2.0, high: 3.0);
  pin com2(low: 2.0, high: 3.0);
  pin com3(low: 2.0, high: 3.0);
  pin com4(low: 2.0, high: 3.0);

  /** 每一位最近一次被选中时的段码：bit0=a、bit1=b、…、bit7=dp。 */
  output channel digit1: number(capacity: 8, overflow: Overflow.drop_oldest);
  output channel digit2: number(capacity: 8, overflow: Overflow.drop_oldest);
  output channel digit3: number(capacity: 8, overflow: Overflow.drop_oldest);
  output channel digit4: number(capacity: 8, overflow: Overflow.drop_oldest);

  state shown1: number = 0;
  state shown2: number = 0;
  state shown3: number = 0;
  state shown4: number = 0;

  /** 段脚为参与点亮的极性：共阴看高电平，共阳看低电平。 */
  pure fn segmentLit(level: Logic) -> bool {
    if commonAnode {
      return level == Logic.low;
    }
    return level == Logic.high;
  }

  /** 公共端的选中极性：共阴低电平选中，共阳高电平选中。 */
  pure fn digitSelected(level: Logic) -> bool {
    if commonAnode {
      return level == Logic.high;
    }
    return level == Logic.low;
  }

  pure fn bit(lit: bool) -> number {
    if lit {
      return 1;
    }
    return 0;
  }

  /** 当前点亮的段，编码成 8 位掩码：bit0=a、bit1=b、…、bit7=dp。 */
  pure fn segmentMask() -> number {
    return bit(segmentLit(a.sample.level))
      + bit(segmentLit(b.sample.level)) * 2
      + bit(segmentLit(c.sample.level)) * 4
      + bit(segmentLit(d.sample.level)) * 8
      + bit(segmentLit(e.sample.level)) * 16
      + bit(segmentLit(f.sample.level)) * 32
      + bit(segmentLit(g.sample.level)) * 64
      + bit(segmentLit(dp.sample.level)) * 128;
  }

  record DigitState {
    active: bool;
    mask: number;
  }

  derived scan1: DigitState = {
    active: digitSelected(com1.sample.level),
    mask: segmentMask()
  };
  derived scan2: DigitState = {
    active: digitSelected(com2.sample.level),
    mask: segmentMask()
  };
  derived scan3: DigitState = {
    active: digitSelected(com3.sample.level),
    mask: segmentMask()
  };
  derived scan4: DigitState = {
    active: digitSelected(com4.sample.level),
    mask: segmentMask()
  };

  /** 上电即锁存当前状态：固定电平的板（装配期就解出电压）不会再有变化事件。 */
  process start {
    if scan1.active {
      shown1 = scan1.mask;
    }
    if scan2.active {
      shown2 = scan2.mask;
    }
    if scan3.active {
      shown3 = scan3.mask;
    }
    if scan4.active {
      shown4 = scan4.mask;
    }
    digit1.send(shown1);
    digit2.send(shown2);
    digit3.send(shown3);
    digit4.send(shown4);
  }

  /** 第 1 位选中期间跟随段码，取消选中后保持。 */
  process scanDigit1 on scan1 {
    if scan1.active && shown1 != scan1.mask {
      shown1 = scan1.mask;
      digit1.send(scan1.mask);
    }
  }

  process scanDigit2 on scan2 {
    if scan2.active && shown2 != scan2.mask {
      shown2 = scan2.mask;
      digit2.send(scan2.mask);
    }
  }

  process scanDigit3 on scan3 {
    if scan3.active && shown3 != scan3.mask {
      shown3 = scan3.mask;
      digit3.send(scan3.mask);
    }
  }

  process scanDigit4 on scan4 {
    if scan4.active && shown4 != scan4.mask {
      shown4 = scan4.mask;
      digit4.send(scan4.mask);
    }
  }
}
