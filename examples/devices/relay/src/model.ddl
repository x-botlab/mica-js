/**
 * 电磁继电器（CT107D 板位 K1，器件值 RELAY-SPDT）。
 *
 * 线圈接在 `coil`（引脚 4）与 `vcc`（引脚 5）之间，`coil` 由 ULN2003 的 OUT5
 * （网络 `N_RELAY`）开集拉低时吸合。两组常开触点：`com`（引脚 3，网络 `m2`）对
 * `no`（引脚 6，接 GND），以及 `com2`（引脚 1，接 GND）对 `no2`（引脚 2，板上悬空）。
 *
 * 理想化：吸合判定只看线圈两端电平（`coil` 非高且 `vcc` 为高），没有吸合/释放延时、
 * 触点弹跳、线圈电感与反激电压、接触电阻温漂与触点寿命。释放时两组触点都移除各自
 * 的 `com`/`com2` 支路，保持真正悬空；线圈的固定支路不受影响。板上并联的续流二极管
 * D1 与线圈侧的 L10/R24 网络不建模。
 */
device RelaySpdt(
  coilResistance: number default 400,
  contactResistance: number default 0.05,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert isFinite(coilResistance) && coilResistance >= 0.001 && coilResistance <= 1_000_000_000,
    "coilResistance must be a finite ohm value within 0.001..1000000000";
  assert isFinite(contactResistance) && contactResistance >= 0.001 && contactResistance <= 1_000_000,
    "contactResistance must be a finite ohm value within 0.001..1000000";
  assert isFinite(lowThreshold) && lowThreshold >= 0,
    "lowThreshold must be finite and non-negative";
  assert isFinite(highThreshold) && highThreshold > lowThreshold,
    "highThreshold must be finite and greater than lowThreshold";

  /** 线圈驱动端（引脚 4）：接 ULN2003 OUT5，开集拉低时吸合。 */
  pin coil(low: lowThreshold, high: highThreshold) = [
    resistor(to: vcc, resistance: coilResistance),
  ];
  /** 线圈正端（引脚 5）：板上接继电器电源。 */
  pin vcc(low: lowThreshold, high: highThreshold);
  /** 触点公共端（引脚 3）：板上接 `m2` 端子。 */
  pin com;
  /** 常开触点（引脚 6）：板上接 GND。 */
  pin no;
  /** 第二组触点公共端（引脚 1）：板上接 GND。 */
  pin com2;
  /** 第二组常开触点（引脚 2）：板上悬空。 */
  pin no2;

  output channel energized: bool(capacity: 8, overflow: Overflow.drop_oldest);

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  derived closed: bool = !isHigh(coil.sample.level) && isHigh(vcc.sample.level);

  fn driveContacts(engaged: bool) {
    if engaged {
      com.intent <- [resistor(to: no, resistance: contactResistance)];
      com2.intent <- [resistor(to: no2, resistance: contactResistance)];
    } else {
      com.intent <- [];
      com2.intent <- [];
    }
  }

  process start {
    driveContacts(closed);
    energized.send(closed);
  }

  process changed on closed {
    driveContacts(closed);
    energized.send(closed);
  }
}
