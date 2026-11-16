/**
 * 测试用的 8080 总线主设备（DDL）。
 *
 * 它只负责把操作序列翻译成引脚电平：CS/RS/WR/RD/RST 与 16 位数据总线。时序按
 * 「一个访问 = 两个 HALF 片段」执行：
 *
 * 1. 片选、RS、数据、WR 拉低，然后挂起 → 边界发布 WR 低；
 * 2. WR 拉高，然后挂起 → 边界发布 WR 上升沿，控制器在此锁存；
 * 3. 同一片段内开始下一个访问。
 *
 * 每次挂起都必须真实跨过一个片段，否则同片段内的多次意图替换只会保留最后一份，
 * 控制器看不到 WR 的上升沿。
 */
export const MASTER_MODEL = `
device BusMaster(accessPeriod: number default 100_000) {
  assert isFinite(accessPeriod) && isInteger(accessPeriod) &&
      accessPeriod >= 10_000 && accessPeriod % 2 == 0,
    "accessPeriod must be an even integer number of picoseconds >= 10000";

  const HALF = accessPeriod / 2;

  record Op {
    command: bool;
    read: bool;
    selected: bool;
    pulse: bool;
    count: number;
    value: number;
  }

  pin d0(low: 0.8, high: 2.0);
  pin d1(low: 0.8, high: 2.0);
  pin d2(low: 0.8, high: 2.0);
  pin d3(low: 0.8, high: 2.0);
  pin d4(low: 0.8, high: 2.0);
  pin d5(low: 0.8, high: 2.0);
  pin d6(low: 0.8, high: 2.0);
  pin d7(low: 0.8, high: 2.0);
  pin d8(low: 0.8, high: 2.0);
  pin d9(low: 0.8, high: 2.0);
  pin d10(low: 0.8, high: 2.0);
  pin d11(low: 0.8, high: 2.0);
  pin d12(low: 0.8, high: 2.0);
  pin d13(low: 0.8, high: 2.0);
  pin d14(low: 0.8, high: 2.0);
  pin d15(low: 0.8, high: 2.0);
  pin cs(low: 0.8, high: 2.0);
  pin rs(low: 0.8, high: 2.0);
  pin wr(low: 0.8, high: 2.0);
  pin rd(low: 0.8, high: 2.0);
  pin rst(low: 0.8, high: 2.0);
  pin vcc;
  pin gnd;

  input channel op: Op(capacity: 8192, overflow: Overflow.drop_new);
  output channel readData: number(capacity: 128, overflow: Overflow.drop_oldest);

  fn driveBit(target: pin, value: number) {
    if value == 1 {
      target.intent <- [resistor(to: vcc, resistance: 25)];
    } else {
      target.intent <- [resistor(to: gnd, resistance: 25)];
    }
  }

  fn driveData(value: number) {
    driveBit(d0, value & 1);
    driveBit(d1, (value >> 1) & 1);
    driveBit(d2, (value >> 2) & 1);
    driveBit(d3, (value >> 3) & 1);
    driveBit(d4, (value >> 4) & 1);
    driveBit(d5, (value >> 5) & 1);
    driveBit(d6, (value >> 6) & 1);
    driveBit(d7, (value >> 7) & 1);
    driveBit(d8, (value >> 8) & 1);
    driveBit(d9, (value >> 9) & 1);
    driveBit(d10, (value >> 10) & 1);
    driveBit(d11, (value >> 11) & 1);
    driveBit(d12, (value >> 12) & 1);
    driveBit(d13, (value >> 13) & 1);
    driveBit(d14, (value >> 14) & 1);
    driveBit(d15, (value >> 15) & 1);
  }

  fn releaseData() {
    d0.intent <- [];
    d1.intent <- [];
    d2.intent <- [];
    d3.intent <- [];
    d4.intent <- [];
    d5.intent <- [];
    d6.intent <- [];
    d7.intent <- [];
    d8.intent <- [];
    d9.intent <- [];
    d10.intent <- [];
    d11.intent <- [];
    d12.intent <- [];
    d13.intent <- [];
    d14.intent <- [];
    d15.intent <- [];
  }

  fn sampleBus() -> number {
    const high = Logic.high;

    return (d0.sample.level == high ? 1 : 0) +
      (d1.sample.level == high ? 2 : 0) +
      (d2.sample.level == high ? 4 : 0) +
      (d3.sample.level == high ? 8 : 0) +
      (d4.sample.level == high ? 16 : 0) +
      (d5.sample.level == high ? 32 : 0) +
      (d6.sample.level == high ? 64 : 0) +
      (d7.sample.level == high ? 128 : 0) +
      (d8.sample.level == high ? 256 : 0) +
      (d9.sample.level == high ? 512 : 0) +
      (d10.sample.level == high ? 1024 : 0) +
      (d11.sample.level == high ? 2048 : 0) +
      (d12.sample.level == high ? 4096 : 0) +
      (d13.sample.level == high ? 8192 : 0) +
      (d14.sample.level == high ? 16384 : 0) +
      (d15.sample.level == high ? 32768 : 0);
  }

  process start {
    cs.intent <- [resistor(to: vcc, resistance: 25)];
    rs.intent <- [resistor(to: vcc, resistance: 25)];
    wr.intent <- [resistor(to: vcc, resistance: 25)];
    rd.intent <- [resistor(to: vcc, resistance: 25)];
    rst.intent <- [resistor(to: vcc, resistance: 25)];
    releaseData();
    loop {
      const next = await op.receive();

      if next.pulse {
        rst.intent <- [resistor(to: gnd, resistance: 25)];
        await ticks(HALF);
        await ticks(HALF);
        rst.intent <- [resistor(to: vcc, resistance: 25)];
        await ticks(HALF);
        await ticks(HALF);
      } else if next.read {
        releaseData();
        if next.selected {
          cs.intent <- [resistor(to: gnd, resistance: 25)];
        }
        rs.intent <- [resistor(to: vcc, resistance: 25)];
        rd.intent <- [resistor(to: gnd, resistance: 25)];
        await ticks(HALF);
        readData.send(sampleBus());
        rd.intent <- [resistor(to: vcc, resistance: 25)];
        cs.intent <- [resistor(to: vcc, resistance: 25)];
        await ticks(HALF);
      } else {
        let remaining = next.count;

        if remaining < 1 {
          remaining = 1;
        }
        while remaining > 0 {
          if next.selected {
            cs.intent <- [resistor(to: gnd, resistance: 25)];
          } else {
            cs.intent <- [resistor(to: vcc, resistance: 25)];
          }
          if next.command {
            rs.intent <- [resistor(to: gnd, resistance: 25)];
          } else {
            rs.intent <- [resistor(to: vcc, resistance: 25)];
          }
          driveData(next.value);
          wr.intent <- [resistor(to: gnd, resistance: 25)];
          await ticks(HALF);
          wr.intent <- [resistor(to: vcc, resistance: 25)];
          await ticks(HALF);
          remaining = remaining - 1;
        }
        cs.intent <- [resistor(to: vcc, resistance: 25)];
        releaseData();
        await ticks(HALF);
      }
    }
  }
}
`;

/**
 * 与 ILI9325 引脚完全一致、但没有任何行为的「空器件」。
 *
 * 它只用于性能对照：同一套总线、同样的电气求解成本，差值就是 ILI9325 模型自身的
 * 开销（总线反应、GRAM 写入、脏矩形维护）。
 */
export const SINK_MODEL = `
device BusSink {
  pin D0(low: 0.8, high: 2.0);
  pin D1(low: 0.8, high: 2.0);
  pin D2(low: 0.8, high: 2.0);
  pin D3(low: 0.8, high: 2.0);
  pin D4(low: 0.8, high: 2.0);
  pin D5(low: 0.8, high: 2.0);
  pin D6(low: 0.8, high: 2.0);
  pin D7(low: 0.8, high: 2.0);
  pin D8(low: 0.8, high: 2.0);
  pin D9(low: 0.8, high: 2.0);
  pin D10(low: 0.8, high: 2.0);
  pin D11(low: 0.8, high: 2.0);
  pin D12(low: 0.8, high: 2.0);
  pin D13(low: 0.8, high: 2.0);
  pin D14(low: 0.8, high: 2.0);
  pin D15(low: 0.8, high: 2.0);
  pin WR(low: 0.8, high: 2.0);
  pin RD(low: 0.8, high: 2.0);
  pin RS(low: 0.8, high: 2.0);
  pin CS(low: 0.8, high: 2.0);
  pin RST(low: 0.8, high: 2.0);
  pin VDD;
  pin VSS;
}
`;
