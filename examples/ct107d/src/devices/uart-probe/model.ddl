/**
 * UART 串口探针：从 RXD 引脚独立复原 8N1 字节流，并可向 TXD 注入字节。
 *
 * 接收端空闲为高；RXD 由高变低时在起始位中点复核，之后每隔一个位时间采样数据位
 * （LSB first），停止位中点必须为高才把字节发布到 `tx`。未知电平按低处理，起始位
 * 复核为高或停止位不为高时丢弃该帧。
 *
 * 注入端由 `send` 输入通道接收 bytes。每个字节依次驱动起始位、8 个数据位（LSB first）
 * 与停止位，数据在停止位结束后发布到 `rx`。每次收到新命令都会递增序号，旧的注入在
 * 下一次定时唤醒时发现序号已过时并退出；若取消时 TXD 正在低电平，新注入先驱动一个
 * 位时间的高电平，确保对端能看到新的下降沿。
 *
 * 位时间按 `round(1e12 / baud)` ps 换算。理想化：无采样时钟误差、线路噪声、毛刺
 * 滤波、传播延迟与电源电流；输入通道溢出不产生线路故障。
 */
device UartProbe(
  baud: number default 9600,
  driveResistance: number default 25
) {
  const bitTime = round(1e12 / baud);
  const halfBitTime = floor(bitTime / 2);
  const maxSendLength = 64;

  assert isSafeInteger(bitTime) && bitTime >= 2,
    "baud must produce an integer bit time of at least 2 ps";
  assert driveResistance >= 0.001 && driveResistance <= 1_000_000_000,
    "driveResistance must be within the supported range";

  pin vcc;
  pin gnd;
  pin rxd(low: 0.8, high: 2.0);
  pin txd;

  input channel send: bytes(
    maxLength: maxSendLength,
    capacity: 8,
    overflow: Overflow.drop_oldest
  );
  output channel tx: bytes(maxLength: 1, capacity: 32, overflow: Overflow.drop_oldest);
  output channel rx: bytes(maxLength: 1, capacity: 32, overflow: Overflow.drop_oldest);

  memory injectBuffer[64];

  /** 注入队列长度；新命令整体替换旧命令。 */
  state injectLength: number = 0;
  /** 每次收到注入命令递增，旧注入用它作废。 */
  state injectionSequence: number = 0;
  /** TXD 最近一次驱动电平，用于取消低电平注入前补一个恢复位。 */
  state txHigh: bool = false;

  /** 接收帧正在进行；帧内新下降沿不重开帧。 */
  state rxBusy: bool = false;
  /** 每次合法起始位递增，触发一次接收过程。 */
  state rxSequence: number = 0;

  /** 未知电平按低：只有 Logic.high 记作高。 */
  derived rxdHigh: bool = rxd.sample.level == Logic.high;

  fn driveTxd(high: bool) {
    txHigh = high;
    if high {
      txd.intent <- [resistor(to: vcc, resistance: driveResistance)];
    } else {
      txd.intent <- [resistor(to: gnd, resistance: driveResistance)];
    }
  }

  /** 把命令字节复制到私有缓冲；复制在同一个调度步内完成。 */
  fn loadInjection(value: bytes) {
    let index = 0;
    while index < value.length {
      store8(injectBuffer, index, value[index]);
      index = index + 1;
    }
    injectLength = value.length;
    injectionSequence = injectionSequence + 1;
  }

  process start {
    driveTxd(true);
    // 本过程是 send 通道的唯一消费者，持续接收注入命令。
    loop {
      const value = await send.receive();
      loadInjection(value);
    }
  }

  reaction startFrame on rxdHigh as (previous, current) {
    if previous && !current && !rxBusy {
      rxBusy = true;
      rxSequence = rxSequence + 1;
    }
  }

  process receiveFrame on rxSequence {
    let sampleAt = now() + halfBitTime;
    await ticks(sampleAt - now());

    // 起始位中点必须为低；未知按低，只有确定的高电平判为假起始位。
    if rxd.sample.level == Logic.high {
      rxBusy = false;
      return;
    }

    let value = 0;
    let bit = 0;
    while bit < 8 {
      sampleAt = sampleAt + bitTime;
      await ticks(sampleAt - now());
      if rxd.sample.level == Logic.high {
        value = value | (1 << bit);
      }
      bit = bit + 1;
    }

    sampleAt = sampleAt + bitTime;
    await ticks(sampleAt - now());
    if rxd.sample.level == Logic.high {
      tx.send(bytes[value]);
    }
    // 停止位中点后即可接受紧邻的下一帧起始位；帧错误静默丢弃。
    rxBusy = false;
  }

  process inject on injectionSequence {
    const token = injectionSequence;
    const count = injectLength;

    let index = 0;
    while index < count {
      if token != injectionSequence {
        return;
      }

      // 旧帧被取消时可能停在低电平；先补一个完整高电平，制造新的下降沿。
      if !txHigh {
        driveTxd(true);
        const recoveryAt = now() + bitTime;
        await ticks(recoveryAt - now());
        if token != injectionSequence {
          return;
        }
      }

      const value = load8(injectBuffer, index);
      driveTxd(false);
      let nextAt = now() + bitTime;
      await ticks(nextAt - now());
      if token != injectionSequence {
        return;
      }

      let bit = 0;
      while bit < 8 {
        const high = ((value >> bit) & 1) == 1;
        driveTxd(high);
        nextAt = nextAt + bitTime;
        await ticks(nextAt - now());
        if token != injectionSequence {
          return;
        }
        bit = bit + 1;
      }

      driveTxd(true);
      nextAt = nextAt + bitTime;
      await ticks(nextAt - now());
      if token != injectionSequence {
        return;
      }

      rx.send(bytes[value]);
      index = index + 1;
    }
  }
}
