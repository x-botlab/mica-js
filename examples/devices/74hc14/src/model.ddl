/**
 * 74HC14 六施密特触发反相器（CT107D 板位 U18）。
 *
 * 六个通道相互独立，每通道 Y = !A；输入在正、负阈值之间时保持上一次输出状态，
 * 因此上升沿与下降沿使用不同的阈值。推挽输出以 `outputResistance` 参考 vcc/gnd，
 * 装配必须把这两根引脚接到真实的 5 V / 0 V 网络。
 *
 * 理想化：零传播延迟，同一时刻多个输入变化不产生毛刺；不模拟传播延迟、输入钳位
 * 二极管、驱动强度与电源电流。输入悬空或处于迟滞带内时保持上一次判定结果；上电
 * 初值按输入为低处理。
 */
device SchmittInverter74hc14(
  outputResistance: number default 25,
  lowThreshold: number default 1.5,
  highThreshold: number default 2.8
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

  state inputHigh1: bool = false;
  state inputHigh2: bool = false;
  state inputHigh3: bool = false;
  state inputHigh4: bool = false;
  state inputHigh5: bool = false;
  state inputHigh6: bool = false;

  fn driveY1() {
    if inputHigh1 {
      y1.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y1.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY2() {
    if inputHigh2 {
      y2.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y2.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY3() {
    if inputHigh3 {
      y3.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y3.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY4() {
    if inputHigh4 {
      y4.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y4.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY5() {
    if inputHigh5 {
      y5.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y5.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn driveY6() {
    if inputHigh6 {
      y6.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      y6.intent <- [resistor(to: vcc, resistance: outputResistance)];
    }
  }

  fn update1() {
    if a1.sample.level == Logic.high {
      inputHigh1 = true;
    } else if a1.sample.level == Logic.low {
      inputHigh1 = false;
    }
    driveY1();
  }

  fn update2() {
    if a2.sample.level == Logic.high {
      inputHigh2 = true;
    } else if a2.sample.level == Logic.low {
      inputHigh2 = false;
    }
    driveY2();
  }

  fn update3() {
    if a3.sample.level == Logic.high {
      inputHigh3 = true;
    } else if a3.sample.level == Logic.low {
      inputHigh3 = false;
    }
    driveY3();
  }

  fn update4() {
    if a4.sample.level == Logic.high {
      inputHigh4 = true;
    } else if a4.sample.level == Logic.low {
      inputHigh4 = false;
    }
    driveY4();
  }

  fn update5() {
    if a5.sample.level == Logic.high {
      inputHigh5 = true;
    } else if a5.sample.level == Logic.low {
      inputHigh5 = false;
    }
    driveY5();
  }

  fn update6() {
    if a6.sample.level == Logic.high {
      inputHigh6 = true;
    } else if a6.sample.level == Logic.low {
      inputHigh6 = false;
    }
    driveY6();
  }

  process start {
    update1();
    update2();
    update3();
    update4();
    update5();
    update6();
  }

  process input1 on a1.sample.level {
    update1();
  }

  process input2 on a2.sample.level {
    update2();
  }

  process input3 on a3.sample.level {
    update3();
  }

  process input4 on a4.sample.level {
    update4();
  }

  process input5 on a5.sample.level {
    update5();
  }

  process input6 on a6.sample.level {
    update6();
  }
}
