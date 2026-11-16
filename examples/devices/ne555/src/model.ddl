/**
 * NE555 定时器（CT107D 的 U15）：无稳态多谐振荡器，为 LCD 负压 VEE 电荷泵提供时钟。
 *
 * 器件级把 rA/rB/c 折叠成两个整数皮秒半周期：
 *   tHigh = 0.693 × (rA + rB) × c   （OUT 高、DISCH 释放，定时电容充电）
 *   tLow  = 0.693 × rB × c          （OUT 低、DISCH 拉低，定时电容放电）
 * 一个自续定时过程在两相之间翻转，每个相位只等待当前半周期。RST# 低电平立刻停振并把
 * OUT、DISCH 拉低，高电平从充电相（高相）重启；THRES/TRIG/CTRL 是不参与行为的被动输入。
 * `frequency` 与 `dutyCycle` 端口在启动时按折叠后的常量发布一次。
 *
 * 理想化：RC 斜坡、1/3·VCC 与 2/3·VCC 比较器阈值、CTRL 输入、DISCH 饱和压降与电源
 * 敏感性均不模拟；半周期取整到整皮秒，输出没有传播延迟。
 */
device Ne555(
  rA: number default 10_000,
  rB: number default 10_000,
  c: number default 1e-8,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const maxTime = 7_200_000_000_000_000;
  // 事件期限必须是整数皮秒，因此两个半周期在创建期各取整一次。
  const tHigh = round(0.693 * (rA + rB) * c * 1e12);
  const tLow = round(0.693 * rB * c * 1e12);

  assert isFinite(rA) && rA >= 1, "rA must be a finite resistance of at least 1 ohm";
  assert isFinite(rB) && rB >= 1, "rB must be a finite resistance of at least 1 ohm";
  assert isFinite(c) && c >= 1e-12, "c must be a finite capacitance of at least 1 pF";
  assert isSafeInteger(tHigh) && tHigh > 0,
    "the charging half period must be a positive integer picosecond duration";
  assert isSafeInteger(tLow) && tLow > 0,
    "the discharging half period must be a positive integer picosecond duration";
  assert tHigh + tLow <= maxTime, "the oscillation period exceeds the supported time range";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";

  pin out;
  pin disch;
  pin rst(low: lowThreshold, high: highThreshold);
  pin thres;
  pin trig;
  pin ctrl;
  pin vcc;
  pin gnd;

  output channel frequency: number(capacity: 4, overflow: Overflow.drop_oldest);
  output channel dutyCycle: number(capacity: 4, overflow: Overflow.drop_oldest);

  /** 是否在振荡；RST# 低电平时为 false。 */
  state running: bool = false;
  /** 当前相位：true 为高相（充电、OUT 高、DISCH 释放），false 为低相。 */
  state high: bool = false;
  /** 当前相位结束的绝对时刻。 */
  state deadline: number = 0;

  fn drivePhase() {
    if !running {
      // 停振：OUT 与开漏的 DISCH 都拉低。
      out.intent <- [resistor(to: gnd, resistance: outputResistance)];
      disch.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else if high {
      out.intent <- [resistor(to: vcc, resistance: outputResistance)];
      disch.intent <- [];
    } else {
      out.intent <- [resistor(to: gnd, resistance: outputResistance)];
      disch.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  fn stopOscillation() {
    running = false;
    high = false;
    drivePhase();
  }

  fn startCharging() {
    const next = now() + tHigh;
    assert isSafeInteger(next) && next <= maxTime,
      "the phase deadline exceeds the supported time range";
    running = true;
    high = true;
    deadline = next;
    drivePhase();
  }

  reaction resetChanged on rst.sample.level as (previous, current) {
    const wasHigh = previous == Logic.high;
    const isHigh = current == Logic.high;
    if wasHigh && !isHigh {
      stopOscillation();
    } else if !wasHigh && isHigh {
      startCharging();
    }
  }

  process start {
    // 未知电平按低处理：只有确定为高才起振。
    if rst.sample.level == Logic.high {
      startCharging();
    } else {
      stopOscillation();
    }
    frequency.send(1e12 / (tHigh + tLow));
    dutyCycle.send(tHigh / (tHigh + tLow) * 100);
  }

  process oscillate on running {
    if !running {
      return;
    }
    loop {
      // RST# 在等待期间可能已经停振：醒来先复查，不驱动任何引脚。
      if !running {
        return;
      }
      const remaining = deadline - now();
      if remaining <= 0 {
        high = !high;
        const next = now() + (high ? tHigh : tLow);
        assert isSafeInteger(next) && next <= maxTime,
          "the phase deadline exceeds the supported time range";
        deadline = next;
        drivePhase();
      }
      await ticks(deadline - now());
    }
  }
}
