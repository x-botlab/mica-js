/**
 * AT24C02 2 Kbit（256 字节）I²C 串行 EEPROM（CT107D 板 U4）。
 *
 * 从机地址为 `1010 A2 A1 A0 R/W#`，A0–A2 在 START 时采样；SDA 是开漏双向端，
 * 只在应答或发送 0 时通过 `outputResistance` 拉低，其余时刻释放，高电平必须由
 * 外部上拉提供。SCL 只被采样，从不驱动，也没有时钟拉伸。
 *
 * 总线状态机与位级 I²C 从机规范一致：SCL 高期间的 SDA 下降沿是 START（重复
 * START 同样处理），上升沿是 STOP；SCL 上升沿采样主机数据位（MSB first），
 * 第 8 个下降沿完成字节并拉低 SDA 应答，第 9 个下降沿释放。错误地址进入忽略
 * 阶段，直到下一个 START/STOP，期间不驱动 SDA。
 *
 * 写事务：第 1 字节是字地址（模 256 回绕），后续数据字节顺序写入，写指针在
 * 8 字节页内回绕。WP 为高时数据字节被丢弃但仍然应答；WP 为高时指针不前进。
 * 读事务：地址字节的 R/W# 为 1 时从当前指针读起，指针在整个 256 字节阵列内
 * 回绕；随机读通过“dummy write 设地址 + 重复 START + 读地址”完成。第 9 个
 * 上升沿采样主机的 ACK/NACK，ACK 继续发送下一字节，NACK 结束发送。
 *
 * 理想化：零传播延迟；无 setup/hold 与总线空闲时间窗；无多主仲裁；无写周期
 * 延迟（每个数据字节在应答时落盘，而不是 STOP + tWC 之后）；无电源电流。
 * 完整 256 字节映像在 `dump` 输出端口上发布：上电一次，之后仅在内容真正改变
 * 时发布。reset 不在本模型中建模，存储内容与协议状态都不会自动清除。
 */
device At24c02(
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
  pin wp(low: lowThreshold, high: highThreshold);

  memory storage[256];

  output channel dump: bytes(
    maxLength: 256,
    capacity: 4,
    overflow: Overflow.drop_oldest
  );

  enum Phase {
    idle,
    receiveAddress,
    receiveWordAddress,
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
  state pointer: number = 0;
  state nextPhase: Phase = Phase.idle;
  state transmitByte: number = 0;
  state transmitBits: number = 0;
  state masterAck: bool = false;
  state masterAckSampled: bool = false;
  state sinking: bool = false;

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

  fn writeDataByte(value: number, protectedLine: bool) {
    // WP 高电平丢弃数据，也不推进指针；无论是否写入都必须应答。
    if !protectedLine {
      const index = pointer & 255;
      const previous = load8(storage, index);
      store8(storage, index, value);
      // 页写缓冲区只在 8 字节页内回绕。
      pointer = (pointer & 248) | ((pointer + 1) & 7);
      if previous != value {
        dump.send(copyBytes(storage, 0, 256));
      }
    }
  }

  fn finishReceivedByte(protectedLine: bool) {
    const byte = receiveShift;
    receiveShift = 0;
    receiveBits = 0;

    if phase == Phase.receiveAddress {
      const matches = (byte & 240) == 160 && ((byte >> 1) & 7) == addressLow;
      if matches {
        if (byte & 1) == 1 {
          acknowledge(Phase.transmit);
        } else {
          acknowledge(Phase.receiveWordAddress);
        }
      } else {
        phase = Phase.ignore;
        sink(false);
      }
    } else if phase == Phase.receiveWordAddress {
      pointer = byte;
      acknowledge(Phase.receiveData);
    } else if phase == Phase.receiveData {
      writeDataByte(byte, protectedLine);
      acknowledge(Phase.receiveData);
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
    transmitByte = load8(storage, pointer);
    transmitBits = 0;
    phase = Phase.transmit;
    // 读指针在整个 256 字节阵列内回绕，不按页回绕。
    pointer = (pointer + 1) & 255;
    placeTransmitBit();
  }

  process start {
    sink(false);
    dump.send(copyBytes(storage, 0, 256));
  }

  reaction busEdge on busCodes as (previous, current)
    capture dataLevel = sda.sample.level,
      addressA0 = a0.sample.level,
      addressA1 = a1.sample.level,
      addressA2 = a2.sample.level,
      writeProtect = wp.sample.level {
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
        phase == Phase.receiveWordAddress ||
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
        phase == Phase.receiveWordAddress ||
        phase == Phase.receiveData;
      if receiving && receiveBits == 8 {
        finishReceivedByte(writeProtect == Logic.high);
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
