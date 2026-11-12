/**
 * DS18B20 单总线数字温度传感器（CT107D 板 U5）。
 *
 * 时隙与复位都理想化为整微秒调度事件，DQ 是开漏双向端，只在存在脉冲与读 0 位时
 * 通过 `outputResistance` 拉低，其余时刻释放，高电平必须由外部 10 kΩ 上拉提供。
 * - 复位：主机拉低 >= 480 us 后释放判复位；从机在释放后 +30 us 拉低、+120 us 释放
 *   形成存在脉冲，协议状态归零，进行中的温度转换被中止（真实芯片不会因复位中止
 *   转换，见理想化）。
 * - 主机写位：下降沿开时隙，从机在 +15 us 采样 DQ，LSB first 移位。
 * - 从机读位：下降沿开时隙，从机在 +15 us 决定输出，0 位拉低到 +60 us，1 位保持释放。
 *
 * ROM 命令：0xCC Skip ROM、0x55 Match ROM（随后比对 8 字节 ROM，失配后静默）、
 * 0x33 Read ROM；0xF0 Search ROM 与 0xEC Alarm Search 未实现，未知 ROM 命令静默。
 * 功能命令：0x44 Convert T（固定 750 ms 虚拟时间，完成时采样 `temperature` 输入写入
 * 暂存器并发布 `temperatureOut`）、0xBE Read Scratchpad（9 字节，末尾 CRC 动态计算）、
 * 0x4E Write Scratchpad（TH/TL/Cfg）；0xB4 Read Power Supply 与 0xB8 Copy Scratchpad
 * 为文档化空操作。
 *
 * 温度编码为 T x 16 的 16 位二进制补码（0.0625 °C 分辨率）；ROM 为族码 0x28 + serial
 * 属性 + 两个 0x00 + Dallas CRC8，创建时固定。暂存器保留字节固定为 0xFF/0x0C/0x00。
 *
 * 理想化：时隙与复位时序为整微秒调度事件、无传播延迟；保留字节固定；无寄生供电；
 * 复位中止进行中的转换（与真实芯片不同）；不模拟驱动强度与电源电流；未知电平按低
 * 处理。
 */
device Ds18b20(
  serial: number default 47049,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const MICROSECOND = 1_000_000;
  const CONVERT_TIME = 750_000_000_000;

  assert isSafeInteger(serial) && serial >= 0 && serial <= 0xffffffff,
    "serial must be an unsigned 32-bit integer";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert lowThreshold >= 0 && lowThreshold <= 5,
    "lowThreshold must be within 0..5 V";
  assert highThreshold > lowThreshold && highThreshold <= 5,
    "highThreshold must be above lowThreshold and within 5 V";

  pin vcc;
  pin gnd;
  pin dq(low: lowThreshold, high: highThreshold);

  input channel temperature: number(capacity: 8, overflow: Overflow.error);
  output channel temperatureOut: number(capacity: 4, overflow: Overflow.drop_oldest);

  memory scratchpad[9];

  enum Phase {
    idle,
    command,
    receive,
    transmit,
    silent
  }

  enum Stage {
    romCommand,
    functionCommand
  }

  enum RxTarget {
    matchRom,
    writeConfig
  }

  enum TxSource {
    romBytes,
    scratchpadBytes
  }

  enum SlotKind {
    sampleSlot,
    driveSlot
  }

  state phase: Phase = Phase.idle;
  state stage: Stage = Stage.romCommand;
  state rxTarget: RxTarget = RxTarget.matchRom;
  state rxByte: number = 0;
  state rxBits: number = 0;
  state romIndex: number = 0;
  state configIndex: number = 0;
  state txSource: TxSource = TxSource.romBytes;
  state txCount: number = 0;
  state txByte: number = 0;
  state txBit: number = 0;
  state ambient: number = 25;

  /** 本器件自己的拉低标记：用于把存在脉冲/读 0 位的边沿与主机边沿区分开。 */
  state sinking: bool = false;
  state lastFallSelf: bool = false;
  state fallTime: number = 0;
  /** 每次总线复位递增；各定时器用它在触发时判断自己的请求是否过期。 */
  state busGeneration: number = 0;

  state slotKind: SlotKind = SlotKind.sampleSlot;
  state slotAt: number = 0;
  state slotGeneration: number = 0;
  state slotSequence: number = 0;

  state presenceAt: number = 0;
  state presenceSequence: number = 0;

  state releaseAt: number = 0;
  state releaseGeneration: number = 0;
  state releaseSequence: number = 0;

  state convertAt: number = 0;
  state convertGeneration: number = 0;
  state convertSequence: number = 0;

  // --- 纯函数：CRC8、ROM 内容、暂存器内容 ---------------------------------------------

  /** Dallas CRC8（多项式 0x31 / 反向 0x8C）的单字节推进。 */
  pure fn crcStep(crc: number, byte: number) -> number {
    let value = crc ^ byte;
    let bit = 0;
    while bit < 8 {
      if value % 2 == 1 {
        value = floor(value / 2) ^ 0x8c;
      } else {
        value = floor(value / 2);
      }
      bit = bit + 1;
    }
    return value;
  }

  /** ROM 前 7 字节：族码 0x28、serial 低 32 位（低位在前）、两个 0x00。 */
  pure fn romBody(index: number) -> number {
    if index == 0 {
      return 0x28;
    }
    if index == 1 {
      return serial % 256;
    }
    if index == 2 {
      return floor(serial / 256) % 256;
    }
    if index == 3 {
      return floor(serial / 65536) % 256;
    }
    if index == 4 {
      return floor(serial / 16777216) % 256;
    }
    return 0;
  }

  /** ROM 第 8 字节：工厂期算好的 Dallas CRC8。 */
  pure fn romCrc() -> number {
    let crc = 0;
    let index = 0;
    while index < 7 {
      crc = crcStep(crc, romBody(index));
      index = index + 1;
    }
    return crc;
  }

  pure fn romByte(index: number) -> number {
    if index < 7 {
      return romBody(index);
    }
    return romCrc();
  }

  /** 暂存器第 9 字节（索引 8）是前 8 字节的动态 CRC8。 */
  pure fn scratchpadCrc() -> number {
    let crc = 0;
    let index = 0;
    while index < 8 {
      crc = crcStep(crc, load8(scratchpad, index));
      index = index + 1;
    }
    return crc;
  }

  pure fn scratchpadByte(index: number) -> number {
    if index < 8 {
      return load8(scratchpad, index);
    }
    return scratchpadCrc();
  }

  pure fn transmitValue(source: TxSource, index: number) -> number {
    if source == TxSource.romBytes {
      return romByte(index);
    }
    return scratchpadByte(index);
  }

  /** 四舍五入，恰为中点时远离零（旧模型行为，区别于 Math.round）。 */
  pure fn roundHalfAway(value: number) -> number {
    const truncated = trunc(value);
    const residual = value - truncated;
    if residual >= 0.5 {
      return truncated + 1;
    }
    if residual <= -0.5 {
      return truncated - 1;
    }
    return truncated;
  }

  derived dqHigh: bool = dq.sample.level == Logic.high;

  // --- 引脚驱动 -------------------------------------------------------------------

  fn sinkLine(active: bool) {
    sinking = active;
    if active {
      dq.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      dq.intent <- [];
    }
  }

  fn armRelease() {
    releaseGeneration = busGeneration;
    releaseAt = now() + 45 * MICROSECOND;
    releaseSequence = releaseSequence + 1;
  }

  // --- 协议：写位采样、读位驱动 -----------------------------------------------------

  fn acceptByte(value: number) {
    if phase == Phase.command {
      if stage == Stage.romCommand {
        if value == 0xcc {
          stage = Stage.functionCommand;
        } else if value == 0x33 {
          beginTransmit(TxSource.romBytes);
        } else if value == 0x55 {
          phase = Phase.receive;
          rxTarget = RxTarget.matchRom;
          romIndex = 0;
        } else {
          // 0xF0 Search ROM / 0xEC Alarm Search 未实现，未知 ROM 命令静默。
          phase = Phase.idle;
        }
      } else {
        if value == 0x44 {
          beginConversion();
        } else if value == 0xbe {
          beginTransmit(TxSource.scratchpadBytes);
        } else if value == 0x4e {
          phase = Phase.receive;
          rxTarget = RxTarget.writeConfig;
          configIndex = 0;
        } else {
          // 0xB4 Read Power Supply / 0xB8 Copy Scratchpad 与未知命令：静默空操作。
          phase = Phase.idle;
        }
      }
    } else if phase == Phase.receive {
      if rxTarget == RxTarget.matchRom {
        if value == romByte(romIndex) {
          romIndex = romIndex + 1;
          if romIndex == 8 {
            stage = Stage.functionCommand;
            phase = Phase.command;
          }
        } else {
          phase = Phase.silent;
        }
      } else {
        store8(scratchpad, 2 + configIndex, value);
        configIndex = configIndex + 1;
        if configIndex == 3 {
          configIndex = 0;
          phase = Phase.idle;
        }
      }
    }
  }

  fn sampleSlot() {
    if slotGeneration != busGeneration {
      return;
    }
    if phase != Phase.command && phase != Phase.receive {
      return;
    }
    const level = dq.sample.level == Logic.high ? 1 : 0;
    rxByte = rxByte + level * pow(2, rxBits);
    rxBits = rxBits + 1;
    if rxBits == 8 {
      const value = rxByte;
      rxByte = 0;
      rxBits = 0;
      acceptByte(value);
    }
  }

  fn driveSlot() {
    if slotGeneration != busGeneration {
      return;
    }
    if phase != Phase.transmit {
      return;
    }
    const value = transmitValue(txSource, txByte);
    const bit = floor(value / pow(2, txBit)) % 2;
    txBit = txBit + 1;
    if txBit == 8 {
      txBit = 0;
      txByte = txByte + 1;
      if txByte >= txCount {
        phase = Phase.idle;
      }
    }
    if bit == 0 {
      sinkLine(true);
      armRelease();
    }
  }

  fn beginTransmit(source: TxSource) {
    txSource = source;
    txByte = 0;
    txBit = 0;
    if source == TxSource.romBytes {
      txCount = 8;
    } else {
      txCount = 9;
    }
    phase = Phase.transmit;
  }

  fn beginConversion() {
    convertGeneration = busGeneration;
    convertAt = now() + CONVERT_TIME;
    convertSequence = convertSequence + 1;
    phase = Phase.idle;
  }

  fn finishConversion() {
    let raw = roundHalfAway(ambient * 16);
    if raw < 0 {
      raw = raw + 65536;
    }
    store8(scratchpad, 0, raw % 256);
    store8(scratchpad, 1, floor(raw / 256) % 256);
    temperatureOut.send(ambient);
  }

  // --- 边沿处理 -------------------------------------------------------------------

  /** 主机下降沿开时隙；>= 480 us 的低脉冲在上升沿判为复位。 */
  fn openSlot() {
    slotGeneration = busGeneration;
    slotAt = now() + 15 * MICROSECOND;
    if phase == Phase.transmit {
      slotKind = SlotKind.driveSlot;
      slotSequence = slotSequence + 1;
    } else if phase == Phase.command || phase == Phase.receive {
      slotKind = SlotKind.sampleSlot;
      slotSequence = slotSequence + 1;
    }
  }

  fn busReset() {
    busGeneration = busGeneration + 1;
    phase = Phase.command;
    stage = Stage.romCommand;
    rxByte = 0;
    rxBits = 0;
    romIndex = 0;
    configIndex = 0;
    txByte = 0;
    txBit = 0;
    presenceAt = now() + 30 * MICROSECOND;
    presenceSequence = presenceSequence + 1;
  }

  fn initializeScratchpad() {
    // 上电暂存器：+25.0 C（0x0190）、TH = 75、TL = 70、12 位配置 0x5F、保留字节。
    store8(scratchpad, 0, 0x90);
    store8(scratchpad, 1, 0x01);
    store8(scratchpad, 2, 75);
    store8(scratchpad, 3, 70);
    store8(scratchpad, 4, 0x5f);
    store8(scratchpad, 5, 0xff);
    store8(scratchpad, 6, 0x0c);
    store8(scratchpad, 7, 0x00);
  }

  process start {
    initializeScratchpad();
    loop {
      const value = await temperature.receive();
      // 非有限值不改变注入温度。
      if isFinite(value) {
        ambient = value;
      }
    }
  }

  reaction dqEdge on dqHigh as (previous, current) {
    if previous && !current {
      // 自己拉低产生的下降沿不开放时隙。
      lastFallSelf = sinking;
      if !sinking {
        fallTime = now();
        openSlot();
      }
    } else if !previous && current {
      if !lastFallSelf {
        if now() - fallTime >= 480 * MICROSECOND {
          busReset();
        }
      }
      lastFallSelf = false;
    }
  }

  /** 写时隙：从机在下降沿 +15 us 采样。 */
  process slotTimer on slotSequence {
    if slotSequence == 0 {
      return;
    }
    loop {
      const remaining = slotAt - now();
      if remaining <= 0 {
        if slotKind == SlotKind.driveSlot {
          driveSlot();
        } else {
          sampleSlot();
        }
        return;
      }
      await ticks(remaining);
    }
  }

  /** 存在脉冲：下降沿 +30 us 拉低，保持 90 us 后释放。 */
  process presenceTimer on presenceSequence {
    if presenceSequence == 0 {
      return;
    }
    loop {
      const remaining = presenceAt - now();
      if remaining <= 0 {
        break;
      }
      await ticks(remaining);
    }
    sinkLine(true);
    await ticks(90 * MICROSECOND);
    sinkLine(false);
  }

  /** 读 0 位的释放：驱动 +45 us（即时隙 +60 us）释放总线。 */
  process releaseTimer on releaseSequence {
    if releaseSequence == 0 {
      return;
    }
    loop {
      const remaining = releaseAt - now();
      if remaining <= 0 {
        if releaseGeneration == busGeneration {
          sinkLine(false);
        }
        return;
      }
      await ticks(remaining);
    }
  }

  /** Convert T：固定 750 ms 后采样注入温度并写入暂存器。 */
  process convertTimer on convertSequence {
    if convertSequence == 0 {
      return;
    }
    loop {
      const remaining = convertAt - now();
      if remaining <= 0 {
        if convertGeneration == busGeneration {
          finishConversion();
        }
        return;
      }
      await ticks(remaining);
    }
  }
}
