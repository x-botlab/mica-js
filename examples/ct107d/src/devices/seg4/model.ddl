/**
 * 共阴四位七段数码管（CT107D 的 DS1/DS2）。
 *
 * 电气：每段阳极（a–g、dp）到每一位的公共阴极（com1–com4）之间是一段等效串联电阻，
 * 与 `blue-led` 相同，平台只提供线性电阻意图，所以没有正向压降、反向截止与发光效率。
 * 8 段 × 4 位共 32 条支路：段脚为高、位脚为低时该段导通。
 *
 * 显示：真实数码管靠多路扫描刷新，人眼看到的是各段亮度的积分。模型不做时间积分，而是把
 * 每一位最近一次被选中时的段码保存下来——这就是「扫描结束后屏上留下的内容」。选中期间
 * 段脚变化会继续跟随（等价于先选位、后写段码也能显示），取消选中（拉高或悬空）后只保持，
 * 不清屏；写全 0 的段码会把该位保存为 0（熄灭）。
 *
 * 理想化：零传播延迟；不模拟亮度、余辉、扫描占空比与人眼积分；公共阴极低有效，
 * 没有共阳变体；段脚不需要外部限流电阻时可直接接驱动，外部电阻可按 blue-led 的做法
 * 并入 `forwardResistance`。
 */
device Seg4(
  forwardResistance: number default 500
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
  // 公共阴极的判定阈值高于普通逻辑脚：线性模型没有正向压降，选中位的公共阴极会被
  // 导通的段路径抬起（8 段全亮时约 1.4 V），而被取消的位由驱动器拉高到 3.5 V 以上。
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

  pure fn bit(level: Logic) -> number {
    if level == Logic.high {
      return 1;
    }
    return 0;
  }

  /** 当前段脚为高的段，编码成 8 位掩码。 */
  pure fn segmentMask() -> number {
    return bit(a.sample.level)
      + bit(b.sample.level) * 2
      + bit(c.sample.level) * 4
      + bit(d.sample.level) * 8
      + bit(e.sample.level) * 16
      + bit(f.sample.level) * 32
      + bit(g.sample.level) * 64
      + bit(dp.sample.level) * 128;
  }

  record DigitState {
    active: bool;
    mask: number;
  }

  derived scan1: DigitState = {
    active: com1.sample.level == Logic.low,
    mask: segmentMask()
  };
  derived scan2: DigitState = {
    active: com2.sample.level == Logic.low,
    mask: segmentMask()
  };
  derived scan3: DigitState = {
    active: com3.sample.level == Logic.low,
    mask: segmentMask()
  };
  derived scan4: DigitState = {
    active: com4.sample.level == Logic.low,
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
