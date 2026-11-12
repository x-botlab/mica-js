/**
 * 74LS04 六反相器（CT107D 板位 U18）。
 *
 * 六个通道相互独立，每通道 Y = !A，推挽输出。输出以 25 Ω 参考 vcc/gnd 引脚，装配必须
 * 把这两根引脚接到真实的 5 V / 0 V 网络。
 *
 * 理想化：零传播延迟，同一时刻多个输入变化不产生毛刺；不模拟 TTL/LS 输入阈值与 LS 输入
 * 电流；输入无内部上下拉，悬空电平由板级网络决定，未知电平按低处理。
 */
device Inverter74ls04(
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

  pin a1(low: lowThreshold, high: highThreshold);
  pin a2(low: lowThreshold, high: highThreshold);
  pin a3(low: lowThreshold, high: highThreshold);
  pin a4(low: lowThreshold, high: highThreshold);
  pin a5(low: lowThreshold, high: highThreshold);
  pin a6(low: lowThreshold, high: highThreshold);
  pin y1;
  pin y2;
  pin y3;
  pin y4;
  pin y5;
  pin y6;
  pin vcc;
  pin gnd;

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  fn driveY1(outputHigh: bool) {
    if outputHigh {
      y1.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      y1.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  fn driveY2(outputHigh: bool) {
    if outputHigh {
      y2.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      y2.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  fn driveY3(outputHigh: bool) {
    if outputHigh {
      y3.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      y3.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  fn driveY4(outputHigh: bool) {
    if outputHigh {
      y4.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      y4.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  fn driveY5(outputHigh: bool) {
    if outputHigh {
      y5.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      y5.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  fn driveY6(outputHigh: bool) {
    if outputHigh {
      y6.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      y6.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  derived y1Out: bool = !isHigh(a1.sample.level);
  derived y2Out: bool = !isHigh(a2.sample.level);
  derived y3Out: bool = !isHigh(a3.sample.level);
  derived y4Out: bool = !isHigh(a4.sample.level);
  derived y5Out: bool = !isHigh(a5.sample.level);
  derived y6Out: bool = !isHigh(a6.sample.level);

  process start {
    driveY1(y1Out);
    driveY2(y2Out);
    driveY3(y3Out);
    driveY4(y4Out);
    driveY5(y5Out);
    driveY6(y6Out);
  }

  process update1 on y1Out {
    driveY1(y1Out);
  }

  process update2 on y2Out {
    driveY2(y2Out);
  }

  process update3 on y3Out {
    driveY3(y3Out);
  }

  process update4 on y4Out {
    driveY4(y4Out);
  }

  process update5 on y5Out {
    driveY5(y5Out);
  }

  process update6 on y6Out {
    driveY6(y6Out);
  }
}
