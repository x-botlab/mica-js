/**
 * 74HC573 八路透明 D 锁存器（CT107D 的 U6–U9 共用本模型）。
 *
 * OE# 低有效：高电平时 Q1–Q8 全部释放（高阻）。LE 高电平透明跟随 D1–D8，LE 下降沿把
 * 当时的字节锁存下来。输出按 25 Ω 推挽驱动，参考 vcc/gnd 引脚，因此装配必须把这两根
 * 引脚接到真实的 5 V / 0 V 网络。
 *
 * 理想化：零传播延迟；LE 下降沿没有 setup/hold 窗口（捕获的是边沿那一刻的电平）；
 * 不模拟驱动强度、扇出与电源电流；输入没有内部上下拉，悬空电平由板级网络决定，读到的
 * 未知电平按低处理。
 */
device Latch74hc573(
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

  pin d0(low: lowThreshold, high: highThreshold);
  pin d1(low: lowThreshold, high: highThreshold);
  pin d2(low: lowThreshold, high: highThreshold);
  pin d3(low: lowThreshold, high: highThreshold);
  pin d4(low: lowThreshold, high: highThreshold);
  pin d5(low: lowThreshold, high: highThreshold);
  pin d6(low: lowThreshold, high: highThreshold);
  pin d7(low: lowThreshold, high: highThreshold);
  pin le(low: lowThreshold, high: highThreshold);
  pin oe(low: lowThreshold, high: highThreshold);
  pin q0;
  pin q1;
  pin q2;
  pin q3;
  pin q4;
  pin q5;
  pin q6;
  pin q7;
  pin vcc;
  pin gnd;

  output channel latch: number(capacity: 8, overflow: Overflow.drop_oldest);

  /** 最近一次锁存的字节，与 Q 是否被 OE# 释放无关。 */
  state stored: number = 0;

  pure fn bit(level: Logic) -> number {
    if level == Logic.high {
      return 1;
    }
    return 0;
  }

  pure fn dataByte() -> number {
    return bit(d0.sample.level)
      + bit(d1.sample.level) * 2
      + bit(d2.sample.level) * 4
      + bit(d3.sample.level) * 8
      + bit(d4.sample.level) * 16
      + bit(d5.sample.level) * 32
      + bit(d6.sample.level) * 64
      + bit(d7.sample.level) * 128;
  }

  derived transparent: bool = le.sample.level == Logic.high;
  derived outputsEnabled: bool = oe.sample.level == Logic.low;
  derived inputs: number = dataByte();

  /** 透明阶段的观察源：LE 电平与数据字节任一项变化都会重算 Q。 */
  record FollowState {
    transparent: bool;
    value: number;
  }

  derived followState: FollowState = {
    transparent: le.sample.level == Logic.high,
    value: dataByte()
  };

  fn driveBit(index: number, level: number) {
    if !outputsEnabled {
      match index {
        0 => { q0.intent <- []; }
        1 => { q1.intent <- []; }
        2 => { q2.intent <- []; }
        3 => { q3.intent <- []; }
        4 => { q4.intent <- []; }
        5 => { q5.intent <- []; }
        6 => { q6.intent <- []; }
        _ => { q7.intent <- []; }
      }
    } else if level == 1 {
      match index {
        0 => { q0.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
        1 => { q1.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
        2 => { q2.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
        3 => { q3.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
        4 => { q4.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
        5 => { q5.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
        6 => { q6.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
        _ => { q7.intent <- [resistor(to: vcc, resistance: outputResistance)]; }
      }
    } else {
      match index {
        0 => { q0.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        1 => { q1.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        2 => { q2.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        3 => { q3.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        4 => { q4.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        5 => { q5.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        6 => { q6.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
        _ => { q7.intent <- [resistor(to: gnd, resistance: outputResistance)]; }
      }
    }
  }

  fn publishAll() {
    driveBit(0, (stored >> 0) & 1);
    driveBit(1, (stored >> 1) & 1);
    driveBit(2, (stored >> 2) & 1);
    driveBit(3, (stored >> 3) & 1);
    driveBit(4, (stored >> 4) & 1);
    driveBit(5, (stored >> 5) & 1);
    driveBit(6, (stored >> 6) & 1);
    driveBit(7, (stored >> 7) & 1);
  }

  process start {
    const current = inputs;
    stored = current;
    latch.send(current);
    publishAll();
  }

  /** 透明阶段：LE 为高时 D 的任意变化直接传到 Q。 */
  process follow on followState {
    if !transparent {
      return;
    }
    const current = inputs;
    stored = current;
    latch.send(current);
    publishAll();
  }

  /** LE 下降沿：锁存此刻的字节。 */
  reaction latchEdge on le.sample.level as (previous, current) {
    if previous == Logic.high && current != Logic.high {
      const value = inputs;
      stored = value;
      latch.send(value);
      publishAll();
    }
  }

  /** OE# 变化只影响输出使能。 */
  reaction enableChanged on oe.sample.level as (previous, current) {
    publishAll();
  }
}
