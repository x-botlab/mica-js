/**
 * 超声波收发器件（CT107D 官方 12.0 / 14.0 固件所需的换能器模块）。
 *
 * 每个明确的高→低完整脉冲都是一次候选触发：上升沿武装候选并撤销旧回波，下降沿以该
 * 时刻为往返传播起点。若后续脉冲的上升沿早于当前候选的回波到达，它会撤销尚未完成的旧
 * 请求，因此这种脉冲串最终只保留最后一个完整脉冲对应的回波；若相邻完整脉冲的间隔已经
 * 长于传播时间，先发生的回波是前一个可按时间区分的候选，模型不预知未来脉冲。不要求
 * 固定脉冲数量、周期或 1 ms 静默窗口。
 *
 * ECHO 空闲为高。完整脉冲下降沿 F 后，经过 D = round(2 × (distanceCm / 100) / 340 × 1e6)
 * µs（`echoUs >= 0` 时直接取显式值）拉低，再保持 D 后恢复高。低电平截止与恢复截止由
 * 两个独立过程等待，各自在唤醒时检查请求序号；新请求即使使 low 截止早于旧 high 截止，
 * 也不会被旧的高电平等待阻塞。
 *
 * 理想化：不模拟 40 kHz 换能器振铃、波束、温度声速变化、最小/最大量程、驱动强度与
 * 电源电流；只保留数字触发/回波时序。
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

  /** 已观察到一个明确的低→高边沿，等待同一脉冲的下降沿。 */
  state pulseArmed: bool = false;
  /** 当前请求是否已经建立回波截止；上升沿与未知电平均会清除它。 */
  state echoPending: bool = false;
  /** ECHO 拉低（回波到达）的绝对截止时间。 */
  state echoLowAt: number = 0;
  /** ECHO 恢复空闲高电平的绝对截止时间。 */
  state echoHighAt: number = 0;
  /** 每次撤销或建立请求时递增，用于让旧定时任务失效。 */
  state echoSequence: number = 0;

  fn driveEcho(high: bool) {
    if high {
      echo.intent <- [resistor(to: vcc, resistance: outputResistance)];
    } else {
      echo.intent <- [resistor(to: gnd, resistance: outputResistance)];
    }
  }

  /** 撤销旧请求并回到空闲高；序号递增使所有旧等待在下次唤醒时退出。 */
  fn cancelEcho() {
    echoPending = false;
    echoSequence = echoSequence + 1;
    driveEcho(true);
  }

  /** 完整脉冲下降沿建立新请求，两个截止都从 F 起算。 */
  fn scheduleEcho() {
    echoLowAt = now() + ECHO_WIDTH;
    echoHighAt = echoLowAt + ECHO_WIDTH;
    assert isSafeInteger(echoLowAt) && echoLowAt <= MAX_TIME,
      "the echo arrival deadline exceeds the supported time range";
    assert isSafeInteger(echoHighAt) && echoHighAt <= MAX_TIME,
      "the echo release deadline exceeds the supported time range";
    echoPending = true;
    echoSequence = echoSequence + 1;
  }

  /**
   * TRIG 逻辑边沿。只有明确的低→高才武装，只有已武装的高→低才完成候选；unknown
   * 与无配对下降都不建立请求。
   */
  reaction trigEdge on trig.sample.level as (previous, current) {
    if current == Logic.unknown {
      pulseArmed = false;
      cancelEcho();
      return;
    }

    if current == Logic.high {
      if previous == Logic.low {
        pulseArmed = true;
        cancelEcho();
      }
      return;
    }

    // current == Logic.low
    if previous == Logic.high && pulseArmed {
      pulseArmed = false;
      scheduleEcho();
    }
  }

  /**
   * ECHO 低电平阶段。旧请求醒来时序号已变化，直接退出；若新的 low 截止更早，旧 high
   * 等待不会占用本过程。D=0 时不驱动低电平，避免制造正宽度伪脉冲。
   */
  process echoLow on echoSequence {
    if !echoPending || ECHO_WIDTH == 0 {
      return;
    }

    const sequence = echoSequence;
    loop {
      if !echoPending || echoSequence != sequence {
        return;
      }
      const remaining = echoLowAt - now();
      if remaining <= 0 {
        driveEcho(false);
        return;
      }
      await ticks(remaining);
    }
  }

  /** ECHO 恢复高电平阶段；与低电平过程独立，彼此不阻塞新请求。 */
  process echoHigh on echoSequence {
    if !echoPending {
      return;
    }

    const sequence = echoSequence;
    loop {
      if !echoPending || echoSequence != sequence {
        return;
      }
      const remaining = echoHighAt - now();
      if remaining <= 0 {
        driveEcho(true);
        return;
      }
      await ticks(remaining);
    }
  }

  process start {
    driveEcho(true);
  }
}
