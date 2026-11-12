/**
 * ULN2003 七路达林顿阵列，开集电极输出（CT107D 板位 U10）。
 *
 * 每通道独立：IN 为高时 OUT 通过 25 Ω 拉低（灌电流），IN 为低或未知时 OUT 释放为高阻，
 * 电平由负载侧决定。芯片只灌不拉，因此没有 vcc 引脚；com 是感性负载续流公共端，仅声明
 * 为被动引脚，不驱动也不模拟钳位二极管。
 *
 * 端口 `mask` 是七路输入的位掩码（bit0..bit6 对应 IN1..IN7），`channels` 是七个 ASCII
 * 字节的 '0'/'1' 状态串。
 *
 * 理想化：零传播延迟；导通压降按 0 V 计（真实约 0.9 V）；不模拟达林顿输入电流、输出
 * 电流限幅与续流行为；未知电平按低处理。
 */
device DarlingtonUln2003(
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert isFinite(lowThreshold) && lowThreshold >= 0,
    "lowThreshold must be finite and non-negative";
  assert isFinite(highThreshold) && highThreshold > lowThreshold,
    "highThreshold must be finite and greater than lowThreshold";

  pin in1(low: lowThreshold, high: highThreshold);
  pin in2(low: lowThreshold, high: highThreshold);
  pin in3(low: lowThreshold, high: highThreshold);
  pin in4(low: lowThreshold, high: highThreshold);
  pin in5(low: lowThreshold, high: highThreshold);
  pin in6(low: lowThreshold, high: highThreshold);
  pin in7(low: lowThreshold, high: highThreshold);
  pin out1;
  pin out2;
  pin out3;
  pin out4;
  pin out5;
  pin out6;
  pin out7;
  /** 感性负载续流公共端：只声明为被动引脚，不驱动、不模拟钳位二极管。 */
  pin com;
  pin gnd;

  output channel mask: number(capacity: 8, overflow: Overflow.drop_oldest);
  output channel channels: bytes(maxLength: 7, capacity: 8, overflow: Overflow.drop_oldest);

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  pure fn composeMask() -> number {
    return (isHigh(in1.sample.level) ? 1 : 0)
      | (isHigh(in2.sample.level) ? 2 : 0)
      | (isHigh(in3.sample.level) ? 4 : 0)
      | (isHigh(in4.sample.level) ? 8 : 0)
      | (isHigh(in5.sample.level) ? 16 : 0)
      | (isHigh(in6.sample.level) ? 32 : 0)
      | (isHigh(in7.sample.level) ? 64 : 0);
  }

  pure fn statusOf(value: number) -> bytes {
    return bytes[
      (value & 1) == 1 ? 0x31 : 0x30,
      (value & 2) == 2 ? 0x31 : 0x30,
      (value & 4) == 4 ? 0x31 : 0x30,
      (value & 8) == 8 ? 0x31 : 0x30,
      (value & 16) == 16 ? 0x31 : 0x30,
      (value & 32) == 32 ? 0x31 : 0x30,
      (value & 64) == 64 ? 0x31 : 0x30
    ];
  }

  fn sink(index: number, active: bool) {
    if active {
      match index {
        1 => { out1.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        2 => { out2.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        3 => { out3.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        4 => { out4.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        5 => { out5.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        6 => { out6.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        7 => { out7.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        _ => { }
      }
    } else {
      match index {
        1 => { out1.intent <- []; }
        2 => { out2.intent <- []; }
        3 => { out3.intent <- []; }
        4 => { out4.intent <- []; }
        5 => { out5.intent <- []; }
        6 => { out6.intent <- []; }
        7 => { out7.intent <- []; }
        _ => { }
      }
    }
  }

  fn applyMask(value: number) {
    sink(1, (value & 1) == 1);
    sink(2, (value & 2) == 2);
    sink(3, (value & 4) == 4);
    sink(4, (value & 8) == 8);
    sink(5, (value & 16) == 16);
    sink(6, (value & 32) == 32);
    sink(7, (value & 64) == 64);
  }

  derived channelMask: number = composeMask();

  process start {
    applyMask(channelMask);
    mask.send(channelMask);
    channels.send(statusOf(channelMask));
  }

  process changed on channelMask {
    applyMask(channelMask);
    mask.send(channelMask);
    channels.send(statusOf(channelMask));
  }
}
