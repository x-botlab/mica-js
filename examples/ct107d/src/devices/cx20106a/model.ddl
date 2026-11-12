/**
 * CX20106A 红外接收前置放大/整形（CT107D 的 U11），比一体化接收头 VS1838 更「裸」一级。
 *
 * 光电二极管电流与 C1/C2/C3/F0 外接网络在本模型中没有电气语义：照明经布尔输入通道
 * `carrier` 注入，f0KHz 仅是元数据。载波出现后 100 µs 把开漏 OUT 拉低，载波消失后
 * 150 µs 释放 OUT，期间输入翻转先取消相反相位的挂起定时，重复电平不重臂。
 * `receiving` 端口跟随解调状态，只有真正变化时才发布。
 *
 * 理想化：放大、f0 带通滤波、检波积分、脉冲整形与 inhibit/AGC 均不模拟；载波检出是
 * 布尔阈值而不是波形。
 */
device Cx20106a(
  f0KHz: number default 38,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const maxTime = 7_200_000_000_000_000;
  const detectDelay = 100_000_000; // 100 µs 载波存在确认
  const releaseDelay = 150_000_000; // 150 µs 载波消失确认

  assert isFinite(f0KHz) && f0KHz >= 30 && f0KHz <= 60,
    "f0KHz must be within the 30..60 kHz band of the part";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";

  pin out;
  pin in(low: lowThreshold, high: highThreshold);
  pin c1;
  pin c2;
  pin c3;
  pin f0;
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
