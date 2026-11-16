/**
 * CT107D 融合式可调放大器（U26 LM324 模拟前端 + RB4 电位器）。
 *
 * 本器件不是通用 14 脚 LM324，也不实现四路独立运放或外部反馈网络求解。它把
 * CT107D USER 页上 U26.1/U26.2/U26.4、R34/R35（100 kΩ）、R36–R39（100 kΩ）
 * 和 RB4（10 kΩ）组成的可调差分放大路径折叠成一个业务模型：
 *
 *   AIN2 = clamp(gain × (IN+ − IN−), 0 … VCC)
 *   gain = 1 + 2 × feedbackResistance / RB4
 *
 * RB4 由内部滑臂位置 0…1 控制：位置 0 走最大阻值（最小增益），位置 1 走
 * minPotResistance 端停（最大增益）。默认参数下增益范围 21…2001。输出不产生
 * 理想电压源，而是用两个正电阻等效为戴维南源（目标电压、outputResistance），
 * 因而具有有限输出阻抗；目标电压被采样到的 GND/VCC 轨夹住。
 *
 * 时间语义：输入采样与输出更新按 updatePeriodUs 周期进行，不是零延迟连续求解。
 * 本模型面向直流/慢变模拟量，不保证外部闭环反馈稳定性；不模拟压摆率、带宽、
 * 输入偏置/失调、共模范围、噪声、电源电流和原图 VEE 负电源。
 */
device Ct107dLm324(
  feedbackResistance: number default 100_000,
  potResistance: number default 10_000,
  minPotResistance: number default 100,
  initialWiper: number default 0,
  outputResistance: number default 25,
  updatePeriodUs: number default 10
) {
  assert isFinite(feedbackResistance) &&
      feedbackResistance >= 0.001 &&
      feedbackResistance <= 1_000_000_000,
    "feedbackResistance must be a finite ohm value within 0.001..1000000000";
  assert isFinite(potResistance) &&
      potResistance >= 0.001 &&
      potResistance <= 1_000_000_000,
    "potResistance must be a finite ohm value within 0.001..1000000000";
  assert isFinite(minPotResistance) &&
      minPotResistance >= 0.001 &&
      minPotResistance <= potResistance,
    "minPotResistance must be within 0.001..potResistance";
  assert isFinite(initialWiper) && initialWiper >= 0 && initialWiper <= 1,
    "initialWiper must be a finite value within 0..1";
  assert isFinite(outputResistance) &&
      outputResistance >= 0.001 &&
      outputResistance <= 100_000,
    "outputResistance must be a finite ohm value within 0.001..100000";
  const updatePeriod = round(updatePeriodUs * 1_000_000);
  assert isFinite(updatePeriodUs) &&
      updatePeriodUs > 0 &&
      isSafeInteger(updatePeriod) &&
      updatePeriod > 0,
    "updatePeriodUs must be a positive value that maps to an integer picosecond period";
  assert updatePeriod <= 7_200_000_000_000_000,
    "updatePeriodUs exceeds the supported time range";

  pin inMinus;
  pin inPlus;
  pin out;
  pin vcc;
  pin gnd;

  record AmplifierSetting {
    position: number;
    gain: number;
  }

  input channel setWiper: number(capacity: 1, overflow: Overflow.drop_oldest);
  output channel setting: AmplifierSetting(capacity: 8, overflow: Overflow.drop_oldest);

  pure fn gainFor(value: number) -> number {
    const effective = minPotResistance + (potResistance - minPotResistance) * (1 - value);
    return 1 + 2 * feedbackResistance / effective;
  }

  state position: number = initialWiper;
  state gain: number = gainFor(initialWiper);
  /** 启动过程置真，唤醒常驻的 setWiper 接收过程。 */
  state controlReady: bool = false;

  fn reportSetting() {
    setting.send({ position: position, gain: gain });
  }

  /**
   * 用两个正电阻构造戴维南等效：空载电压 target、串联电阻 outputResistance。
   * 目标贴轨时只保留一条到对应轨的电阻，避免另一条变成超大阻值。
   */
  fn driveOutput() {
    const plus = inPlus.sample.voltage;
    const minus = inMinus.sample.voltage;
    const high = vcc.sample.voltage;
    const low = gnd.sample.voltage;

    if plus == none || minus == none || high == none || low == none {
      out.intent <- [];
      return;
    }
    if high <= low {
      out.intent <- [];
      return;
    }

    let target = gain * (plus - minus);
    if target < low {
      target = low;
    } else if target > high {
      target = high;
    }

    if target <= low {
      out.intent <- [resistor(to: gnd, resistance: outputResistance)];
      return;
    }
    if target >= high {
      out.intent <- [resistor(to: vcc, resistance: outputResistance)];
      return;
    }

    const span = high - low;
    const toVcc = outputResistance * span / (target - low);
    const toGnd = outputResistance * span / (high - target);
    if toVcc > 1_000_000_000 || toGnd > 1_000_000_000 {
      // 目标贴近某条轨时，另一条支路会超出可表示上限；空载误差 ≤ Rout×span/1 GΩ。
      if target - low <= high - target {
        out.intent <- [resistor(to: gnd, resistance: outputResistance)];
      } else {
        out.intent <- [resistor(to: vcc, resistance: outputResistance)];
      }
      return;
    }
    out.intent <- [
      resistor(to: vcc, resistance: toVcc),
      resistor(to: gnd, resistance: toGnd)
    ];
  }

  process start {
    controlReady = true;
    reportSetting();
    loop {
      driveOutput();
      await ticks(updatePeriod);
    }
  }

  /**
   * 电位器位置由宿主方法投递。启动过程置 controlReady 后，本过程常驻在输入
   * 通道上接收新位置；位置变化立即更新增益并发布事件，输出电压在下一个
   * updatePeriod 边界刷新。
   */
  process control on controlReady {
    loop {
      const requested = await setWiper.receive();
      assert isFinite(requested) && requested >= 0 && requested <= 1,
        "setWiper must be a finite value within 0..1";
      if requested != position {
        position = requested;
        gain = gainFor(requested);
        reportSetting();
      }
    }
  }
}
