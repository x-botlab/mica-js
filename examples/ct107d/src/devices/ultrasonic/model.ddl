/**
 * 超声波收发器件（CT107D 官方 12.0 / 14.0 固件所需的换能器模块）。
 *
 * TRIG 在 1 ms 脉冲间隔窗口内累计 8 个上升沿；第 8 个脉冲的下降沿标志完整脉冲串
 * 结束。固件从此时启动接收计时并等待 ECHO 下降，因此 ECHO 空闲为高：完整脉冲串结束
 * 后先保持高，经过往返传播时间 round(2 × (distanceCm / 100) / 340 × 1e6) µs 再拉低，
 * 低电平持续同等时间后恢复高。`echoUs >= 0` 时直接使用显式传播时间。完整脉冲串结束
 * 时递增请求序号，旧回波定时即使仍在队列中也会因序号不匹配而失效。
 *
 * 理想化：不模拟 40 kHz 换能器振铃、波束、温度声速变化、最小/最大量程、驱动强度与
 * 电源电流；只保留官方固件判读所需的数字触发/回波时序。
 */
device Ultrasonic(
  distanceCm: number default 100,
  echoUs: number default -1,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const MICROSECOND = 1_000_000;
  const MAX_TIME = 7_200_000_000_000_000;
  const TRIGGER_PULSES = 8;
  const BURST_GAP = 1_000 * MICROSECOND;

  assert isFinite(distanceCm) && distanceCm >= 0,
    "distanceCm must be a finite non-negative distance";
  assert echoUs == -1 || (isSafeInteger(echoUs) && echoUs >= 0),
    "echoUs must be -1 or a non-negative safe integer number of microseconds";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert lowThreshold >= 0 && lowThreshold <= 5,
    "lowThreshold must be within 0..5 V";
  assert highThreshold > lowThreshold && highThreshold <= 5,
    "highThreshold must be above lowThreshold and within 5 V";

  // distanceCm 以厘米注入；340 m/s 换算到厘米需要先除以 100。
  const derivedEchoUs = round(2 * (distanceCm / 100) / 340 * 1_000_000);
  const effectiveEchoUs = echoUs >= 0 ? echoUs : derivedEchoUs;
  const ECHO_WIDTH = effectiveEchoUs * MICROSECOND;

  assert isSafeInteger(ECHO_WIDTH) && ECHO_WIDTH >= 0 && ECHO_WIDTH <= MAX_TIME,
    "the calculated echo width exceeds the supported time range";

  pin trig(low: lowThreshold, high: highThreshold);
  pin echo;
  pin vcc;
  pin gnd;

  derived trigHigh: bool = trig.sample.level == Logic.high;

  /** 当前脉冲串已累计的上升沿数。 */
  state pulseCount: number = 0;
  /** 每个 TRIG 上升沿递增，用于重启脉冲间隔定时器。 */
  state pulseSequence: number = 0;
  /** 最近一个 TRIG 上升沿时刻，用于判断脉冲串是否已经中断。 */
  state lastPulseAt: number = 0;
  /** ECHO 拉低（回波到达）的时刻。 */
  state echoLowAt: number = 0;
  /** ECHO 恢复空闲高电平的时刻。 */
  state echoHighAt: number = 0;
  /** 每次检测到完整脉冲串递增，用于取消旧请求的回波定时。 */
  state echoSequence: number = 0;

  fn driveEcho(high: bool) {
    if high {
      echo.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      echo.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  fn beginEcho() {
    pulseCount = 0;
    echoLowAt = now() + ECHO_WIDTH;
    echoHighAt = echoLowAt + ECHO_WIDTH;
    assert isSafeInteger(echoLowAt) && echoLowAt <= MAX_TIME,
      "the echo arrival deadline exceeds the supported time range";
    assert isSafeInteger(echoHighAt) && echoHighAt <= MAX_TIME,
      "the echo release deadline exceeds the supported time range";
    echoSequence = echoSequence + 1;
  }

  reaction trigEdge on trigHigh as (previous, current) {
    if previous == current {
      return;
    }

    if current {
      pulseSequence = pulseSequence + 1;
      lastPulseAt = now();
      if pulseCount < TRIGGER_PULSES {
        pulseCount = pulseCount + 1;
      }
      return;
    }

    // 第 8 个脉冲完整结束；此时固件刚好启动接收计时。
    if pulseCount == TRIGGER_PULSES {
      beginEcho();
    }
  }

  /** 最后一个 TRIG 上升沿后 1 ms 没有新边沿，则丢弃不完整的脉冲串。 */
  process burstGapTimer on pulseSequence {
    if pulseSequence == 0 {
      return;
    }

    loop {
      // 进程源变化只登记 pending；从最近边沿重新计算期限，确保每次唤醒都收敛到
      // 「最后一个上升沿 + 1 ms」，而不是沿用首个边沿的旧期限。
      const deadline = lastPulseAt + BURST_GAP;
      assert isSafeInteger(deadline) && deadline <= MAX_TIME,
        "the burst-gap deadline exceeds the supported time range";
      const remaining = deadline - now();
      if remaining <= 0 {
        pulseCount = 0;
        return;
      }
      await ticks(remaining);
    }
  }

  /** 回波到达后拉低，低电平结束后恢复空闲高；旧请求不得改动新请求的线路。 */
  process echoPulse on echoSequence {
    if echoSequence == 0 {
      return;
    }

    const sequence = echoSequence;
    while echoSequence == sequence {
      const toLow = echoLowAt - now();
      if toLow > 0 {
        await ticks(toLow);
      }
      if echoSequence != sequence {
        return;
      }
      driveEcho(false);

      const toHigh = echoHighAt - now();
      if toHigh > 0 {
        await ticks(toHigh);
      }
      if echoSequence != sequence {
        return;
      }
      driveEcho(true);
      return;
    }
  }

  process start {
    driveEcho(true);
  }
}
