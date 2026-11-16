/**
 * MCP4017 7 位单路 I²C 数字电位器（CT117E-M4 板 U3，MCP4017T-104ELT）。
 *
 * 真实器件只有 W 与 B 两个电阻端：W–B 是 128 级 rheostat，A 端在 MCP4017 内部
 * 悬空，不存在 W–VCC 的固定电阻支路。VDD/VSS 只供 I²C 接口，不进入电阻梯求解。
 * 本模型在 W 与 B 之间贡献 RWB = RAB × code / 127 + RW，code 为 0..127；code 0
 * 仍保留 RW，因此端点电阻有限。滑臂电压由板级线性电阻网络求解。
 *
 * I²C 从机地址固定为 0101111（写字节 0x5E、读字节 0x5F），没有地址引脚。SDA 是
 * 开漏双向端，只在应答或发送 0 时通过 outputResistance 拉低，其余时刻释放，高
 * 电平必须由外部上拉提供；SCL 只被采样，不驱动，也没有时钟拉伸。
 *
 * 写事务：地址匹配后每个数据字节的低 7 位写入 wiper，MSB 忽略；数据在应答位期间
 * 更新，因此一个事务可连续写多个字节。读事务：地址匹配后从当前 wiper 发送
 * 0xxxxxxx，主机 ACK 继续发送同一值，NACK 结束；STOP 或重复 START 都终止事务。
 * 上电默认 wiper 为 0x3F（midscale）。地址不匹配进入忽略阶段，直到下一个
 * START/STOP，期间不驱动 SDA。
 *
 * 理想化：零传播延迟；无 setup/hold、总线空闲时间窗与毛刺滤波；无多主仲裁；不
 * 建模 VDD 门限、电源电流、总线超时与电阻梯电压范围；wiper 电阻为常量，不随
 * 电压、温度或 code 非线性变化。
 */
device Mcp4017(
  rab: number default 100_000,
  wiperResistance: number default 100,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const POR_WIPER = 0x3f;

  assert isFinite(rab) && rab >= 0.001 && rab <= 1_000_000_000,
    "rab must be a finite ohm value within 0.001..1000000000";
  assert isFinite(wiperResistance) &&
      wiperResistance >= 0.001 &&
      wiperResistance <= 1_000_000_000,
    "wiperResistance must be a finite ohm value within 0.001..1000000000";
  assert rab + wiperResistance <= 1_000_000_000,
    "rab + wiperResistance must not exceed the 1 GΩ pin intent limit";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert lowThreshold >= 0 && lowThreshold <= 5,
    "lowThreshold must be within 0..5 V";
  assert highThreshold > lowThreshold && highThreshold <= 5,
    "highThreshold must be above lowThreshold and within 5 V";

  pin vdd;
  pin vss;
  pin sda(low: lowThreshold, high: highThreshold);
  pin scl(low: lowThreshold, high: highThreshold) =
    [resistor(to: vss, resistance: 1_000_000)];
  pin w = [resistor(to: b, resistance: rab * POR_WIPER / 127 + wiperResistance)];
  pin b;

  output channel wiper: number(capacity: 16, overflow: Overflow.drop_oldest);
  output channel resistance: number(capacity: 16, overflow: Overflow.drop_oldest);
  output channel voltage: number(capacity: 16, overflow: Overflow.drop_oldest);

  enum Phase {
    idle,
    receiveAddress,
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
  state nextPhase: Phase = Phase.idle;
  state transmitByte: number = 0;
  state transmitBits: number = 0;
  state masterAck: bool = false;
  state masterAckSampled: bool = false;
  state sinking: bool = false;
  state wiperCode: number = POR_WIPER;
  state pendingWiper: number = POR_WIPER;
  state pendingWrite: bool = false;

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

  pure fn resistanceFor(code: number) -> number {
    return rab * code / 127 + wiperResistance;
  }

  derived busCodes: BusCodes = {
    clockCode: busCode(scl.sample.level),
    dataCode: busCode(sda.sample.level)
  };

  fn sink(enabled: bool) {
    sinking = enabled;
    if sinking {
      sda.intent <- [resistor(to: vss, resistance: outputResistance)];
    } else {
      sda.intent <- [];
    }
  }

  fn acknowledge(next: Phase) {
    nextPhase = next;
    sink(true);
    phase = Phase.acknowledge;
  }

  fn applyWiper(code: number) {
    const next = code & 0x7f;
    if next != wiperCode {
      wiperCode = next;
      w.intent <- [resistor(to: b, resistance: resistanceFor(next))];
      wiper.send(next);
      resistance.send(resistanceFor(next));
    }
  }

  fn reportVoltage() {
    const sampled = w.sample.voltage;
    if sampled != none {
      voltage.send(sampled);
    }
  }

  fn finishReceivedByte() {
    const byte = receiveShift;
    receiveShift = 0;
    receiveBits = 0;

    if phase == Phase.receiveAddress {
      if (byte & 0xfe) == 0x5e {
        if (byte & 1) == 1 {
          acknowledge(Phase.transmit);
        } else {
          acknowledge(Phase.receiveData);
        }
      } else {
        phase = Phase.ignore;
        sink(false);
      }
    } else if phase == Phase.receiveData {
      // 8 位收齐后先暂存，等第 9 个时钟的应答位结束再真正写入。
      pendingWiper = byte & 0x7f;
      pendingWrite = true;
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
    transmitByte = wiperCode & 0x7f;
    transmitBits = 0;
    phase = Phase.transmit;
    placeTransmitBit();
  }

  process start {
    sink(false);
    wiper.send(wiperCode);
    resistance.send(resistanceFor(wiperCode));
    reportVoltage();
  }

  reaction wiperVoltageChanged on w.sample.voltage as (previous, current) {
    reportVoltage();
  }

  reaction busEdge on busCodes as (previous, current)
    capture dataLevel = sda.sample.level {
    const clockHigh = current.clockCode == 1;
    const clockWasHigh = previous.clockCode == 1;
    const dataHigh = current.dataCode == 1;
    const dataWasHigh = previous.dataCode == 1;

    if clockWasHigh && clockHigh && dataWasHigh && !dataHigh {
      // START / 重复 START：主机重新掌握 SDA；未完成的数据字节丢弃。
      sink(false);
      phase = Phase.receiveAddress;
      receiveShift = 0;
      receiveBits = 0;
      pendingWrite = false;
    } else if clockWasHigh && clockHigh && !dataWasHigh && dataHigh {
      // STOP：结束当前事务，丢弃未确认的数据字节。
      sink(false);
      phase = Phase.idle;
      receiveShift = 0;
      receiveBits = 0;
      pendingWrite = false;
    } else if !clockWasHigh && clockHigh {
      // SCL 上升沿：接收阶段采样主机数据位，主机 ACK 阶段采样 ACK/NACK。
      const receiving = phase == Phase.receiveAddress || phase == Phase.receiveData;
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
      const receiving = phase == Phase.receiveAddress || phase == Phase.receiveData;
      if receiving && receiveBits == 8 {
        finishReceivedByte();
      } else if phase == Phase.acknowledge {
        sink(false);
        // 数据只在应答位期间写入：重复 START/STOP 提前终止时留在 pending。
        if pendingWrite {
          applyWiper(pendingWiper);
          pendingWrite = false;
        }
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
