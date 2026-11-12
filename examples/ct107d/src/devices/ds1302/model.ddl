/**
 * DS1302 涓流充电实时时钟（CT107D 板 U19）。
 *
 * 三线接口按数据手册编码实现，边沿理想化为同步事件：
 * - RST 上升沿复位位计数并把接口切到命令阶段；RST 下降沿释放 IO 并回到空闲。
 * - RST 为高时，SCLK 每个上升沿采样 IO，LSB first 移入 8 位命令字节：bit7 必须
 *   为 1（否则忽略整个事务）、bit6 选 RAM 面（0 = 时钟、1 = RAM）、bit5..1 为
 *   地址（时钟 0..7、RAM 0..30、31 = 突发）、bit0 为 1 表示读。因此 0x81/0x80 是
 *   秒寄存器、0xBE/0xBF 是时钟突发、0xFE/0xFF 是 RAM 突发。
 * - 写事务：命令之后每个 SCLK 上升沿采样一位，凑满一字节立即生效。读事务：命令
 *   之后每个 SCLK 下降沿把下一位驱动到 IO，位为 1 时释放（开漏，靠外部上拉）。
 *
 * 寄存器（全部 BCD）：0 秒（bit7 = CH 停振）、1 分、2 时（仅 24 小时制）、3 日、
 * 4 月、5 星期（1..7）、6 年（00..99 -> 2000..2099）、7 WP（bit7 = 写保护）。
 * 时钟突发传 8 字节（秒..年，末尾是 WP），RAM 突发传 31 字节。WP = 1 时时钟与 RAM
 * 写全部忽略（读不受影响），但 WP 寄存器自身的单字节写仍可写，保证竞赛板驱动
 * 「清 WP -> 写 -> 置 WP」的流程可用。
 *
 * 走时由 1 s 虚拟时间 tick 驱动，BCD 进位级联到分、时、日、星期、月、年（闰年算到
 * 2096、大小月、二月闰年 29 天），CH = 1 时停振。秒寄存器写入后与每秒走时后发布
 * `datetime`（19 字节 ASCII `YYYY-MM-DD HH:MM:SS`）与 `running`（CH = 0 为真）。
 *
 * 理想化：X1/X2 晶振物理层不模拟（内部 1 s tick）；走时与供电解耦，主电掉电不丢
 * 时钟与 RAM；涓流充电与 12 小时制不模拟；无效 BCD 原样存储；突发写超长回绕；
 * 不模拟传播延迟、驱动强度与电源电流。IO 是开漏双向端，只在读事务的 0 位通过
 * `outputResistance` 拉低，其余时刻释放，高电平必须由外部上拉提供；未知电平按低
 * 处理。
 */
device Ds1302(
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const SECOND = 1_000_000_000_000;

  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";
  assert lowThreshold >= 0 && lowThreshold <= 5,
    "lowThreshold must be within 0..5 V";
  assert highThreshold > lowThreshold && highThreshold <= 5,
    "highThreshold must be above lowThreshold and within 5 V";

  pin vcc;
  pin vcc1;
  pin gnd;
  // 晶振引脚纯被动，32.768 kHz 振荡器不建模。
  pin x1;
  pin x2;
  pin rst(low: lowThreshold, high: highThreshold);
  pin sclk(low: lowThreshold, high: highThreshold);
  pin io(low: lowThreshold, high: highThreshold);

  output channel datetime: bytes(maxLength: 19, capacity: 4, overflow: Overflow.drop_oldest);
  output channel running: bool(capacity: 4, overflow: Overflow.drop_oldest);

  memory clockRegs[8];
  memory ram[31];

  enum Phase {
    idle,
    command,
    write,
    read,
    ignore
  }

  record Bus {
    clockHigh: bool;
    dataHigh: bool;
  }

  record BcdStep {
    value: number;
    carried: bool;
  }

  state phase: Phase = Phase.idle;
  state commandByte: number = 0;
  state commandBits: number = 0;
  state dataByte: number = 0;
  state dataBits: number = 0;
  state writeIndex: number = 0;
  state readIndex: number = 0;
  state writeProtect: bool = false;
  state lastRunning: bool = false;

  derived rstHigh: bool = rst.sample.level == Logic.high;

  /** 命令/读位同时需要 SCLK 与 IO 的同一时刻电平，先汇成扁平记录再比较。 */
  derived bus: Bus = {
    clockHigh: sclk.sample.level == Logic.high,
    dataHigh: io.sample.level == Logic.high
  };

  fn setIo(active: bool) {
    if active {
      io.intent <- [resistor(to: gnd, resistance: outputResistance)];
    } else {
      io.intent <- [];
    }
  }

  pure fn halted() -> bool {
    return load8(clockRegs, 0) >= 128;
  }

  pure fn bcdToBinary(value: number) -> number {
    const low = value % 16;
    const high = floor(value / 16) % 16;
    return high * 10 + low;
  }

  /** 两位 BCD 自增；低位 9 -> 0 时进位，高位到 maxHigh 时整体回零。 */
  pure fn incBcd(value: number, maxHigh: number) -> BcdStep {
    const low = value % 16;
    const high = floor(value / 16) % 16;
    if low == 9 {
      if high == maxHigh {
        return { value: 0, carried: true };
      }
      return { value: (high + 1) * 16, carried: false };
    }
    return { value: high * 16 + low + 1, carried: false };
  }

  pure fn commandAddress() -> number {
    return floor(commandByte / 2) % 32;
  }

  pure fn commandIsRam() -> bool {
    return commandByte % 128 >= 64;
  }

  pure fn commandIsBurst() -> bool {
    return commandAddress() == 31;
  }

  /** 时钟突发第 8 字节是 WP，读回 bit7。 */
  pure fn burstClockValue(index: number) -> number {
    const slot = index % 8;
    if slot < 7 {
      return load8(clockRegs, slot);
    }
    if writeProtect {
      return 128;
    }
    return 0;
  }

  /** 当前读事务在 `index`（字节序号）上的输出字节；单字节读写固定回同一字节。 */
  pure fn streamValue(index: number) -> number {
    if commandIsBurst() {
      if commandIsRam() {
        return load8(ram, index % 31);
      }
      return burstClockValue(index);
    }
    if commandIsRam() {
      return load8(ram, commandAddress() % 31);
    }
    if commandAddress() < 7 {
      return load8(clockRegs, commandAddress());
    }
    if writeProtect {
      return 128;
    }
    return 0;
  }

  /** ASCII `YYYY-MM-DD HH:MM:SS`，按 19 个元素逐字节构造。 */
  pure fn datetimeBytes() -> bytes {
    const year = 2000 + bcdToBinary(load8(clockRegs, 6));
    const month = bcdToBinary(load8(clockRegs, 4));
    const date = bcdToBinary(load8(clockRegs, 3));
    const hour = bcdToBinary(load8(clockRegs, 2));
    const minute = bcdToBinary(load8(clockRegs, 1));
    const second = bcdToBinary(load8(clockRegs, 0) % 128);
    return bytes[
      48 + floor(year / 1000) % 10,
      48 + floor(year / 100) % 10,
      48 + floor(year / 10) % 10,
      48 + year % 10,
      45,
      48 + floor(month / 10) % 10,
      48 + month % 10,
      45,
      48 + floor(date / 10) % 10,
      48 + date % 10,
      32,
      48 + floor(hour / 10) % 10,
      48 + hour % 10,
      58,
      48 + floor(minute / 10) % 10,
      48 + minute % 10,
      58,
      48 + floor(second / 10) % 10,
      48 + second % 10
    ];
  }

  fn publishStatus() {
    datetime.send(datetimeBytes());
    const active = !halted();
    if active != lastRunning {
      lastRunning = active;
      running.send(active);
    }
  }

  fn initializeRegisters() {
    // 上电时刻 2026-01-01 00:00:00，星期四。
    store8(clockRegs, 0, 0x00);
    store8(clockRegs, 1, 0x00);
    store8(clockRegs, 2, 0x00);
    store8(clockRegs, 3, 0x01);
    store8(clockRegs, 4, 0x01);
    store8(clockRegs, 5, 0x04);
    store8(clockRegs, 6, 0x26);
    store8(clockRegs, 7, 0x00);
    let index = 0;
    while index < 31 {
      store8(ram, index, 0);
      index = index + 1;
    }
    writeProtect = false;
    phase = Phase.idle;
    commandByte = 0;
    commandBits = 0;
    dataByte = 0;
    dataBits = 0;
    writeIndex = 0;
    readIndex = 0;
    setIo(false);
  }

  fn latchCommand() {
    commandBits = 0;
    dataBits = 0;
    dataByte = 0;
    writeIndex = 0;
    readIndex = 0;
    if commandByte < 128 {
      phase = Phase.ignore;
      setIo(false);
    } else if commandByte % 2 == 1 {
      phase = Phase.read;
    } else {
      phase = Phase.write;
    }
  }

  fn applyWrite(value: number) {
    if commandIsBurst() {
      if commandIsRam() {
        if !writeProtect {
          store8(ram, writeIndex % 31, value);
        }
      } else if !writeProtect {
        // WP = 1 丢弃整个时钟突发，包括末尾的 WP 字节。
        const slot = writeIndex % 8;
        if slot < 7 {
          store8(clockRegs, slot, value);
          publishStatus();
        } else if value >= 128 {
          writeProtect = true;
        } else {
          writeProtect = false;
        }
      }
      writeIndex = writeIndex + 1;
      return;
    }
    if commandIsRam() {
      if !writeProtect {
        store8(ram, commandAddress() % 31, value);
      }
      return;
    }
    if commandAddress() == 7 {
      // WP 寄存器自身保持可写，主机才能解除保护。
      writeProtect = value >= 128;
      return;
    }
    if writeProtect {
      return;
    }
    if commandAddress() < 7 {
      store8(clockRegs, commandAddress(), value);
      publishStatus();
    }
  }

  /** 1 s 走时：秒 -> 分 -> 时 -> 日 -> 星期 -> 月 -> 年，逐级 BCD 进位。 */
  fn advanceSecond() {
    const secondsReg = load8(clockRegs, 0);
    const secondStep = incBcd(secondsReg % 128, 5);
    if secondsReg >= 128 {
      store8(clockRegs, 0, 128 + secondStep.value);
    } else {
      store8(clockRegs, 0, secondStep.value);
    }
    if !secondStep.carried {
      return;
    }
    const minuteStep = incBcd(load8(clockRegs, 1), 5);
    store8(clockRegs, 1, minuteStep.value);
    if !minuteStep.carried {
      return;
    }
    const hourReg = load8(clockRegs, 2);
    if hourReg == 0x23 {
      store8(clockRegs, 2, 0x00);
    } else {
      store8(clockRegs, 2, incBcd(hourReg, 9).value);
    }
    if hourReg != 0x23 {
      return;
    }
    const dateReg = load8(clockRegs, 3);
    const monthReg = load8(clockRegs, 4);
    const yearReg = load8(clockRegs, 6);
    const month = bcdToBinary(monthReg);
    const year = bcdToBinary(yearReg);
    let days = 31;
    if month == 2 {
      if year % 4 == 0 {
        days = 29;
      } else {
        days = 28;
      }
    } else if month == 4 || month == 6 || month == 9 || month == 11 {
      days = 30;
    }
    const monthCarry = bcdToBinary(dateReg) >= days;
    if monthCarry {
      store8(clockRegs, 3, 0x01);
    } else {
      store8(clockRegs, 3, incBcd(dateReg, 9).value);
    }
    // 星期在每次午夜递增，而不是只在月末。
    const weekdayReg = load8(clockRegs, 5);
    if weekdayReg >= 7 {
      store8(clockRegs, 5, 0x01);
    } else {
      store8(clockRegs, 5, weekdayReg + 1);
    }
    if !monthCarry {
      return;
    }
    if monthReg == 0x12 {
      store8(clockRegs, 4, 0x01);
      if yearReg == 0x99 {
        store8(clockRegs, 6, 0x00);
      } else {
        store8(clockRegs, 6, incBcd(yearReg, 9).value);
      }
    } else {
      store8(clockRegs, 4, incBcd(monthReg, 9).value);
    }
  }

  process start {
    initializeRegisters();
    datetime.send(datetimeBytes());
    lastRunning = !halted();
    running.send(lastRunning);
    loop {
      await ticks(SECOND);
      // CH = 1 时停振且不发布，和旧模型一致。
      if !halted() {
        advanceSecond();
        publishStatus();
      }
    }
  }

  reaction resetEdge on rstHigh as (previous, current) {
    if current && !previous {
      phase = Phase.command;
      commandByte = 0;
      commandBits = 0;
      dataByte = 0;
      dataBits = 0;
      writeIndex = 0;
      readIndex = 0;
      setIo(false);
    } else if previous && !current {
      phase = Phase.idle;
      setIo(false);
    }
  }

  reaction busEdge on bus as (previous, current) {
    if !previous.clockHigh && current.clockHigh {
      // SCLK 上升沿：命令字节或写数据位 LSB first 移入。
      if phase == Phase.command {
        commandByte = commandByte + (current.dataHigh ? 1 : 0) * pow(2, commandBits);
        commandBits = commandBits + 1;
        if commandBits == 8 {
          latchCommand();
        }
      } else if phase == Phase.write {
        dataByte = dataByte + (current.dataHigh ? 1 : 0) * pow(2, dataBits);
        dataBits = dataBits + 1;
        if dataBits == 8 {
          const value = dataByte;
          dataByte = 0;
          dataBits = 0;
          applyWrite(value);
        }
      }
    } else if previous.clockHigh && !current.clockHigh {
      // SCLK 下降沿：读事务把下一位放到 IO 上，0 位拉低、1 位释放。
      if phase == Phase.read {
        const byte = streamValue(floor(readIndex / 8));
        const bit = floor(byte / pow(2, readIndex % 8)) % 2;
        readIndex = readIndex + 1;
        setIo(bit == 0);
      }
    }
  }
}
