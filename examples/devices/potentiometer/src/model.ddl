/**
 * 三端线性电位器：VDD、GND 与滑臂 W。
 *
 * 滑臂同时经两段电阻连接到 VDD 与 GND。position 0 表示滑臂靠近 GND，1 表示靠近
 * VDD；两段都保留 endResistance，因此端点仍是有限电阻，不会出现 0 Ω 短路。
 * 滑臂电压完全由板级线性电阻网络求解，包括外部负载的影响；本模型不产生任何固定
 * 电压或电流源。
 *
 * `setPosition` 在运行期完整替换两段电阻。`position` 与滑臂有效采样电压分别从
 * `position`、`voltage` 输出端口发布；滑臂网络浮空时没有确定的 sample.voltage，
 * 不发布伪造的电压值。
 *
 * 理想化：无触点抖动与噪声、无机械行程/锥度、无额定功率、温度系数与寄生电容；
 * VDD/GND 只作为普通引脚参与网络，不建模极性保护或电源电流。
 */
device Potentiometer(
  trackResistance: number default 10_000,
  endResistance: number default 10,
  initialPosition: number default 0.5
) {
  assert isFinite(trackResistance) &&
      trackResistance >= 0.001 &&
      trackResistance <= 1_000_000_000,
    "trackResistance must be a finite ohm value within 0.001..1000000000";
  assert isFinite(endResistance) &&
      endResistance >= 0.001 &&
      endResistance <= 1_000_000_000,
    "endResistance must be a finite ohm value within 0.001..1000000000";
  assert trackResistance + endResistance <= 1_000_000_000,
    "trackResistance + endResistance must not exceed the 1 GΩ pin intent limit";
  assert isFinite(initialPosition) && initialPosition >= 0 && initialPosition <= 1,
    "initialPosition must be a finite value within 0..1";

  pin vdd;
  pin gnd;
  pin wiper = [
    resistor(
      to: vdd,
      resistance: endResistance + trackResistance * (1 - initialPosition)
    ),
    resistor(to: gnd, resistance: endResistance + trackResistance * initialPosition)
  ];

  input channel setPosition: number(capacity: 8, overflow: Overflow.error);
  output channel position: number(capacity: 16, overflow: Overflow.drop_oldest);
  output channel voltage: number(capacity: 16, overflow: Overflow.drop_oldest);

  state currentPosition: number = initialPosition;

  pure fn upperResistance(value: number) -> number {
    return endResistance + trackResistance * (1 - value);
  }

  pure fn lowerResistance(value: number) -> number {
    return endResistance + trackResistance * value;
  }

  fn applyPosition(value: number) {
    if value == currentPosition {
      return;
    }
    currentPosition = value;
    wiper.intent <- [
      resistor(to: vdd, resistance: upperResistance(value)),
      resistor(to: gnd, resistance: lowerResistance(value))
    ];
    position.send(value);
  }

  fn reportVoltage() {
    const sampled = wiper.sample.voltage;
    if sampled != none {
      voltage.send(sampled);
    }
  }

  process start {
    position.send(currentPosition);
    reportVoltage();
    loop {
      const next = await setPosition.receive();
      assert isFinite(next) && next >= 0 && next <= 1,
        "setPosition must be a finite value within 0..1";
      applyPosition(next);
    }
  }

  reaction wiperVoltageChanged on wiper.sample.voltage as (previous, current) {
    reportVoltage();
  }
}
