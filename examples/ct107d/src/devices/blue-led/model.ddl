/**
 * 蓝色 LED（InGaN，典型正向电压 3.0 V 级、额定电流 20 mA）。
 *
 * 电气模型沿用平台合同：无源器件只能声明线性电阻意图，因此这里把 LED 建模成
 * 「阳极–阴极之间的等效串联电阻」。正向电流由外部网络的电阻分压决定，亮度按
 * 正向电流相对额定电流归一化；反向时电流为负，亮度被钳到 0。
 *
 * `forwardResistance` 默认取 500 Ω：5 V / 330 Ω 的常见接法因此落在 LED 约 3.0 V、6 mA 的
 * 位置，与典型蓝色 LED 的工作点接近，亮度约 0.3；直接接 5 V 时是 10 mA、亮度 0.5。
 *
 * 平台没有二极管耗尽层、正向压降与反向击穿的意图类型，所以本模型不含 Vf、不阻塞
 * 反向电流，也不做温度或发光效率建模。这些简化在 README 与 device.json 里同步说明。
 */
device BlueLed(forwardResistance: number default 500, ratedCurrent: number default 0.02) {
  assert isFinite(forwardResistance)
      && forwardResistance >= 0.001
      && forwardResistance <= 1_000_000_000,
    "forwardResistance must be a finite ohm value within 0.001..1000000000";

  assert isFinite(ratedCurrent) && ratedCurrent > 0 && ratedCurrent <= 1,
    "ratedCurrent must be a finite ampere value within (0, 1]";

  /** 阳极–阴极的等效串联电阻：正向导通时决定电流。 */
  pin anode = [resistor(to: cathode, resistance: forwardResistance)];
  pin cathode;

  /** 归一化亮度：正向电流 / 额定电流，钳到 [0, 1]。 */
  output channel brightness: number(capacity: 64);
  /** 阳极到阴极的电流，单位 A；反向为负。 */
  output channel current: number(capacity: 64);
  /** 阳极相对阴极的电压，单位 V。 */
  output channel voltage: number(capacity: 64);

  fn report() {
    const a = anode.sample.voltage;
    const k = cathode.sample.voltage;
    if a != none && k != none {
      const v = a - k;
      const i = v / forwardResistance;
      voltage.send(v);
      current.send(i);
      brightness.send(min(1, max(0, i / ratedCurrent)));
    } else {
      // 至少一端浮空：没有确定的电压与电流，指示器保持熄灭。
      voltage.send(0);
      current.send(0);
      brightness.send(0);
    }
  }

  process start {
    report();
  }

  reaction anodeChanged on anode.sample.voltage as (previous, next) {
    report();
  }

  reaction cathodeChanged on cathode.sample.voltage as (previous, next) {
    report();
  }
}
