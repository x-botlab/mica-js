/**
 * LM386 音频功率放大器（CT107D 板位 U14），驱动板载喇叭 SP1。
 *
 * 本模型是理想数字跟随器：线性放大无法在数字网络上表示，因此 OUT 只取逻辑电平——
 * INP 为高且 INN 为低时推挽到 vcc，否则推挽到 gnd。板上 INN 通常接地，此时 OUT 直接
 * 跟随 INP；把 INP 与 INN 驱动到同一电平可以抑制输出。端口 `active` 报告 OUT 是否为高。
 *
 * 理想化：不建模电压增益（`gain` 属性只是元数据，20 与 200 对逻辑输出没有区别）、偏置、
 * BYPASS/GAIN 引脚网络与模拟波形；gain1/gain8/bypass 是仅声明的被动引脚；不模拟电源
 * 电流、驱动强度与失真；未知电平按低处理。
 */
device AmplifierLm386(
  gain: number default 20,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert gain == 20 || gain == 200, "gain must be 20 or 200";
  assert isFinite(lowThreshold) && lowThreshold >= 0,
    "lowThreshold must be finite and non-negative";
  assert isFinite(highThreshold) && highThreshold > lowThreshold,
    "highThreshold must be finite and greater than lowThreshold";

  pin inp(low: lowThreshold, high: highThreshold);
  pin inn(low: lowThreshold, high: highThreshold);
  pin out;
  /** GAIN1/GAIN8/BYPASS 只声明为被动引脚，增益与旁路网络不参与数字行为。 */
  pin gain1;
  pin gain8;
  pin bypass;
  pin vcc;
  pin gnd;

  output channel active: bool(capacity: 8, overflow: Overflow.drop_oldest);

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  derived outHigh: bool = isHigh(inp.sample.level) && !isHigh(inn.sample.level);

  fn driveOut(high: bool) {
    if high {
      out.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      out.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  process start {
    driveOut(outHigh);
    active.send(outHigh);
  }

  process changed on outHigh {
    driveOut(outHigh);
    active.send(outHigh);
  }
}
