/**
 * 有源蜂鸣器（CT107D 板位 SP1，器件值 BUZZER）。
 *
 * 板上正端 `p` 接 VCC，负端 `n` 接 ULN2003 的 OUT7（网络 `N_BUZZ`）；达林顿拉低时
 * 两端构成回路、蜂鸣器发声。电气上是一段负载电阻，开集输出释放后由这段电阻把 `n`
 * 拉回 VCC，因此 `active` 端口（正端为高、负端非高）会立即回到 false。
 *
 * 理想化：不模拟发声频率、声压、驱动电流上限与机械共振。有源蜂鸣器自带振荡电路，
 * 只要两端有电压就发声，与固件输出方波还是恒定电平无关。
 */
device Buzzer(
  loadResistance: number default 100,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert isFinite(loadResistance) && loadResistance >= 0.001 && loadResistance <= 1_000_000_000,
    "loadResistance must be a finite ohm value within 0.001..1000000000";
  assert isFinite(lowThreshold) && lowThreshold >= 0,
    "lowThreshold must be finite and non-negative";
  assert isFinite(highThreshold) && highThreshold > lowThreshold,
    "highThreshold must be finite and greater than lowThreshold";

  /** 正端：板上接 VCC。 */
  pin p(low: lowThreshold, high: highThreshold);
  /** 负端：板上接 ULN2003 OUT7（开集输出），两端之间是负载电阻。 */
  pin n(low: lowThreshold, high: highThreshold) = [resistor(to: p, resistance: loadResistance)];

  output channel active: bool(capacity: 8, overflow: Overflow.drop_oldest);

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  derived energized: bool = isHigh(p.sample.level) && !isHigh(n.sample.level);

  process start {
    active.send(energized);
  }

  process changed on energized {
    active.send(energized);
  }
}
