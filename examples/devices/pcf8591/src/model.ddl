/**
 * PCF8591 8 位 A/D + D/A 转换器（CT107D 板 U16）。
 *
 * 从机地址为 `1001 A2 A1 A0 R/W#`，A0–A2 在 START 时采样；SDA 是开漏双向端，
 * 只在应答或发送 0 时通过 `outputResistance` 拉低，其余时刻释放，高电平必须由
 * 外部上拉提供。SCL 只被采样，从不驱动，也没有时钟拉伸。总线状态机与
 * AT24C02 模型同规约。
 *
 * 写事务：第 1 字节是控制字节（bit6 DAC 使能、bit2 通道自动递增、bit1:0 通道
 * 选择；bit5/bit4 接受但不模拟），后续字节写入 DAC 寄存器并以 `aout` 端口发布
 * `value / 255`。读事务：返回当前选中通道的 `round(255 × ain)`；自动递增模式
 * 下每读出一字节通道 +1（3→0 回绕）；第 9 个上升沿采样主机 ACK/NACK。
 *
 * 模拟输入 `vin0`–`vin3` 与模拟输出 `dac` 是纯被动引脚：没有电气采样或驱动
 * 语义，四路输入值由输入通道 `ain0`–`ain3` 注入（0..1，超出范围时钳位），DAC
 * 值只通过 `aout` 端口观测。`osc`/`ext` 同样被动，默认内部振荡，外部时钟选项
 * 不模拟。
 *
 * 理想化：零传播与转换延迟；无采样保持；不模拟首次读流水线（真实芯片首个读
 * 字节返回上次转换值，本模型立即转换）；DAC 使能位不门控 `aout` 发布；bit5/
 * bit4、OSC/EXT 与电源电流不模拟。输出端口在上电时各发布一次，之后仅在值变化
 * 时发布。
 */
device Pcf8591(
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert lowThreshold >= 0 && lowThreshold <= 5,
    "lowThreshold must be within 0..5 V";
  assert highThreshold > lowThreshold && highThreshold <= 5,
    "highThreshold must be above lowThreshold and within 5 V";

  pin vcc;
  pin gnd;
  pin sda(low: lowThreshold, high: highThreshold);
  pin scl(low: lowThreshold, high: highThreshold) =
    [resistor(to: gnd, resistance: 1_000_000)];
  pin a0(low: lowThreshold, high: highThreshold);
  pin a1(low: lowThreshold, high: highThreshold);
  pin a2(low: lowThreshold, high: highThreshold);
  // 模拟引脚不在电气域建模；真实名称由 device.json 的 label 保留。
  pin vin0;
  pin vin1;
  pin vin2;
  pin vin3;
  pin dac;
  pin osc;
  pin ext;

  input channel ain0: number(capacity: 8, overflow: Overflow.error);
  input channel ain1: number(capacity: 8, overflow: Overflow.error);
  input channel ain2: number(capacity: 8, overflow: Overflow.error);
  input channel ain3: number(capacity: 8, overflow: Overflow.error);

  output channel aout: number(capacity: 16, overflow: Overflow.drop_oldest);
  output channel channel: number(capacity: 16, overflow: Overflow.drop_oldest);

  enum Phase {
    idle,
    receiveAddress,
    receiveControl,
    receiveData,
    acknowledge,
    transmit,
    masterAck,
    ignore
  }

  record BusCodes {
    clockCode: number;
    dataCode: number;
  }

  state phase: Phase = Phase.idle;
  state receiveShift: number = 0;
  state receiveBits: number = 0;
  state addressLow: number = 0;
  state controlByte: number = 0;
  state channelIndex: number = 0;
  state dacLevel: number = 0;
  state nextPhase: Phase = Phase.idle;
  state transmitByte: number = 0;
  state transmitBits: number = 0;
  state masterAck: bool = false;
  state masterAckSampled: bool = false;
  state sinking: bool = false;
  state analog0: number = 0;
  state analog1: number = 0;
  state analog2: number = 0;
  state analog3: number = 0;
  /** 四个接收过程共用的启动信号；process start 置真后各过程常驻等待自己的通道。 */
  state sampling: bool = false;

  /** 未知电平按低处理：只有 Logic.high 记作 1。 */
  pure fn sampleBit(level: Logic) -> number {
    if level == Logic.high {
      return 1;
    }
    return 0;
  }

  /** 总线编码保留未知：高=1、低=0、未知=2。 */
  pure fn busCode(level: Logic) -> number {
    if level == Logic.high {
      return 1;
    } else if level == Logic.low {
      return 0;
    }
    return 2;
  }

  pure fn clampedInput(value: number) -> number {
    if isNaN(value) || value < 0 {
      return 0;
    } else if value > 1 {
      return 1;
    }
    return value;
  }

  derived busCodes: BusCodes = {
    clockCode: busCode(scl.sample.level),
    dataCode: busCode(sda.sample.level)
  };

  fn sink(enabled: bool) {
    sinking = enabled;
    if sinking {
      sda.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      sda.intent <- [];
    }
  }

  fn acknowledge(next: Phase) {
    nextPhase = next;
    sink(true);
    phase = Phase.acknowledge;
  }

  fn selectedAnalog() -> number {
    if channelIndex == 0 {
      return analog0;
    } else if channelIndex == 1 {
      return analog1;
    } else if channelIndex == 2 {
      return analog2;
    }
    return analog3;
  }

  fn convertedByte() -> number {
    return round(clampedInput(selectedAnalog()) * 255);
  }

  fn writeControl(byte: number) {
    controlByte = byte;
    const selected = byte & 3;
    if selected != channelIndex {
      channelIndex = selected;
      channel.send(channelIndex);
    }
  }

  fn writeDac(byte: number) {
    // DAC 使能位不门控寄存器更新，和旧模型一致。
    if dacLevel != byte {
      dacLevel = byte;
      aout.send(dacLevel / 255);
    }
  }

  fn placeTransmitBit() {
    if transmitBits < 8 {
      const position = 7 - transmitBits;
      const bit = (transmitByte >> position) & 1;
      sink(bit == 0);
      transmitBits = transmitBits + 1;
    } else {
      // 8 位发完，释放 SDA 让主机驱动第 9 个时钟的 ACK/NACK。
      sink(false);
      phase = Phase.masterAck;
      masterAckSampled = false;
    }
  }

  fn beginTransmit() {
    transmitByte = convertedByte();
    transmitBits = 0;
    phase = Phase.transmit;
    if (controlByte & 4) != 0 {
      channelIndex = (channelIndex + 1) & 3;
      channel.send(channelIndex);
    }
    placeTransmitBit();
  }

  fn finishReceivedByte() {
    const byte = receiveShift;
    receiveShift = 0;
    receiveBits = 0;

    if phase == Phase.receiveAddress {
      const matches = (byte & 240) == 144 && ((byte >> 1) & 7) == addressLow;
      if matches {
        if (byte & 1) == 1 {
          acknowledge(Phase.transmit);
        } else {
          acknowledge(Phase.receiveControl);
        }
      } else {
        phase = Phase.ignore;
        sink(false);
      }
    } else if phase == Phase.receiveControl {
      writeControl(byte);
      acknowledge(Phase.receiveData);
    } else if phase == Phase.receiveData {
      writeDac(byte);
      acknowledge(Phase.receiveData);
    }
  }

  process capture0 on sampling {
    loop {
      const raw = await ain0.receive();
      analog0 = clampedInput(raw);
    }
  }

  process capture1 on sampling {
    loop {
      const raw = await ain1.receive();
      analog1 = clampedInput(raw);
    }
  }

  process capture2 on sampling {
    loop {
      const raw = await ain2.receive();
      analog2 = clampedInput(raw);
    }
  }

  process capture3 on sampling {
    loop {
      const raw = await ain3.receive();
      analog3 = clampedInput(raw);
    }
  }

  process start {
    sink(false);
    // 先置启动信号，让四个接收过程在首个推进中就绪并常驻等待。
    sampling = true;
    aout.send(dacLevel / 255);
    channel.send(channelIndex);
  }

  reaction busEdge on busCodes as (previous, current)
    capture dataLevel = sda.sample.level,
      addressA0 = a0.sample.level,
      addressA1 = a1.sample.level,
      addressA2 = a2.sample.level {
    const clockHigh = current.clockCode == 1;
    const clockWasHigh = previous.clockCode == 1;
    const dataHigh = current.dataCode == 1;
    const dataWasHigh = previous.dataCode == 1;

    if clockWasHigh && clockHigh && dataWasHigh && !dataHigh {
      // START / 重复 START：主机重新掌握 SDA，并在此刻锁存 A2..A0。
      sink(false);
      phase = Phase.receiveAddress;
      receiveShift = 0;
      receiveBits = 0;
      addressLow = sampleBit(addressA2) * 4 +
        sampleBit(addressA1) * 2 +
        sampleBit(addressA0);
    } else if clockWasHigh && clockHigh && !dataWasHigh && dataHigh {
      // STOP：结束当前事务，释放 SDA。
      sink(false);
      phase = Phase.idle;
      receiveShift = 0;
      receiveBits = 0;
    } else if !clockWasHigh && clockHigh {
      // SCL 上升沿：接收阶段采样主机数据位，主机 ACK 阶段采样 ACK/NACK。
      const receiving = phase == Phase.receiveAddress ||
        phase == Phase.receiveControl ||
        phase == Phase.receiveData;
      if receiving && receiveBits < 8 {
        receiveShift = (receiveShift << 1) | sampleBit(dataLevel);
        receiveBits = receiveBits + 1;
      } else if phase == Phase.masterAck && !masterAckSampled {
        // 主机拉低表示 ACK（继续发送）；高电平表示 NACK。未知按低处理。
        masterAck = dataLevel != Logic.high;
        masterAckSampled = true;
      }
    } else if clockWasHigh && !clockHigh {
      // SCL 下降沿：第 8 个下降沿完成接收字节，第 9 个下降沿推进状态机。
      const receiving = phase == Phase.receiveAddress ||
        phase == Phase.receiveControl ||
        phase == Phase.receiveData;
      if receiving && receiveBits == 8 {
        finishReceivedByte();
      } else if phase == Phase.acknowledge {
        sink(false);
        if nextPhase == Phase.transmit {
          beginTransmit();
        } else {
          phase = nextPhase;
          receiveShift = 0;
          receiveBits = 0;
        }
      } else if phase == Phase.transmit {
        placeTransmitBit();
      } else if phase == Phase.masterAck && masterAckSampled {
        if masterAck {
          beginTransmit();
        } else {
          phase = Phase.ignore;
          sink(false);
        }
      }
    }
  }
}
