/**
 * VS1838 一体化 38 kHz 红外接收头（CT107D 的 U20）：光电二极管、前置放大与解调都在封装内。
 *
 * 照明没有外部引脚，而是经布尔输入通道 `carrier` 注入。载波出现后 50 µs 把开漏 OUT 拉低
 * （短于 50 µs 的毛刺不触发），消失后 200 µs 释放 OUT；输入翻转先取消相反相位的挂起定时，
 * 重复电平不重臂。`receiving` 端口跟随解调状态，只有真正变化时才发布。
 *
 * 理想化：不模拟 38 kHz 频率匹配、AGC（连续载波约 60 ms 后停止响应）与脉冲整形；
 * 照明是布尔值而不是波形。
 */
device Vs1838(
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const maxTime = 7_200_000_000_000_000;
  const detectDelay = 50_000_000; // 50 µs 载波存在确认
  const releaseDelay = 200_000_000; // 200 µs 载波消失确认

  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";

  pin out;
  pin vcc;
  pin gnd;

  input channel carrier: bool(capacity: 8, overflow: Overflow.error);
  output channel receiving: bool(capacity: 8, overflow: Overflow.drop_oldest);

  /** 最近一次接受的载波电平。 */
  state carrierOn: bool = false;
  /** 解调状态：true 表示 OUT 已被拉低。 */
  state detected: bool = false;
  state detectArmed: bool = false;
  state detectDeadline: number = 0;
  state releaseArmed: bool = false;
  state releaseDeadline: number = 0;

  fn pullLow() {
    detected = true;
    out.intent <- [resistor(to: gnd, resistance: outputResistance)];
    receiving.send(true);
  }

  fn releaseOutput() {
    detected = false;
    out.intent <- [];
    receiving.send(false);
  }

  process start {
    out.intent <- [];
    receiving.send(false);
    // 启动过程同时是该通道的唯一消费者。
    loop {
      const level = await carrier.receive();
      if level != carrierOn {
        carrierOn = level;
        if level {
          // 翻转先取消相反相位的挂起定时，再按当前时刻起算。
          releaseArmed = false;
          const next = now() + detectDelay;
          assert isSafeInteger(next) && next <= maxTime,
            "the detect deadline exceeds the supported time range";
          detectDeadline = next;
          detectArmed = true;
        } else {
          detectArmed = false;
          const next = now() + releaseDelay;
          assert isSafeInteger(next) && next <= maxTime,
            "the release deadline exceeds the supported time range";
          releaseDeadline = next;
          releaseArmed = true;
        }
      }
    }
  }

  process detectTimer on detectArmed {
    if !detectArmed {
      return;
    }
    loop {
      // 挂起期间可能已被输入翻转取消：醒来复查后直接结束。
      if !detectArmed {
        return;
      }
      const remaining = detectDeadline - now();
      if remaining <= 0 {
        detectArmed = false;
        if !detected {
          pullLow();
        }
        return;
      }
      await ticks(remaining);
    }
  }

  process releaseTimer on releaseArmed {
    if !releaseArmed {
      return;
    }
    loop {
      if !releaseArmed {
        return;
      }
      const remaining = releaseDeadline - now();
      if remaining <= 0 {
        releaseArmed = false;
        if detected {
          releaseOutput();
        }
        return;
      }
      await ticks(remaining);
    }
  }
}
