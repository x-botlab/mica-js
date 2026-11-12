/**
 * 74HC138 3-8 译码器，输出低有效（CT107D 板位 U24）。
 *
 * 使能条件为 E1#=0、E2#=0、E3=1：选中的一路 Yn# 拉低，其余全部拉高；任一条件不满足时
 * 八路输出全部拉高。输出推挽驱动并参考 vcc/gnd 引脚，装配必须把这两根引脚接到真实的
 * 5 V / 0 V 网络。
 *
 * 端口 `select` 给出当前选中的 0–7，禁用时为 -1；`enabled` 给出使能状态；`code` 用两个
 * ASCII 字节给出 "Y0".."Y7" 或 "--"。
 *
 * 理想化：零传播延迟，同刻多输入变化原子重算、无毛刺；不模拟输入阈值回差、驱动强度与
 * 电源电流；未知电平按低处理，因此悬空的 E1#/E2# 视为低、悬空的 A/B/C 视为 0。
 */
device Decoder74hc138(
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

  pin a(low: lowThreshold, high: highThreshold);
  pin b(low: lowThreshold, high: highThreshold);
  pin c(low: lowThreshold, high: highThreshold);
  pin e1(low: lowThreshold, high: highThreshold);
  pin e2(low: lowThreshold, high: highThreshold);
  pin e3(low: lowThreshold, high: highThreshold);
  pin y0;
  pin y1;
  pin y2;
  pin y3;
  pin y4;
  pin y5;
  pin y6;
  pin y7;
  pin vcc;
  pin gnd;

  output channel select: number(capacity: 8, overflow: Overflow.drop_oldest);
  output channel enabled: bool(capacity: 8, overflow: Overflow.drop_oldest);
  output channel code: bytes(maxLength: 2, capacity: 8, overflow: Overflow.drop_oldest);

  record Decoded {
    index: number;
    active: bool;
  }

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  pure fn decode() -> Decoded {
    const enabledLow = !isHigh(e1.sample.level) && !isHigh(e2.sample.level);
    if !(enabledLow && isHigh(e3.sample.level)) {
      return { index: -1, active: false };
    }
    return {
      index: (isHigh(a.sample.level) ? 1 : 0)
        + (isHigh(b.sample.level) ? 2 : 0)
        + (isHigh(c.sample.level) ? 4 : 0),
      active: true
    };
  }

  pure fn codeOf(index: number) -> bytes {
    if index < 0 {
      return bytes[0x2d, 0x2d];
    }
    return bytes[0x59, 0x30 + index];
  }

  fn driveY0(low: bool) {
    if low {
      y0.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y0.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY1(low: bool) {
    if low {
      y1.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y1.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY2(low: bool) {
    if low {
      y2.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y2.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY3(low: bool) {
    if low {
      y3.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y3.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY4(low: bool) {
    if low {
      y4.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y4.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY5(low: bool) {
    if low {
      y5.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y5.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY6(low: bool) {
    if low {
      y6.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y6.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY7(low: bool) {
    if low {
      y7.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y7.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn applyDecode(value: Decoded) {
    driveY0(value.index == 0);
    driveY1(value.index == 1);
    driveY2(value.index == 2);
    driveY3(value.index == 3);
    driveY4(value.index == 4);
    driveY5(value.index == 5);
    driveY6(value.index == 6);
    driveY7(value.index == 7);
  }

  derived decoded: Decoded = decode();

  process start {
    applyDecode(decoded);
    select.send(decoded.index);
    enabled.send(decoded.active);
    code.send(codeOf(decoded.index));
  }

  process changed on decoded {
    applyDecode(decoded);
    select.send(decoded.index);
    enabled.send(decoded.active);
    code.send(codeOf(decoded.index));
  }
}
