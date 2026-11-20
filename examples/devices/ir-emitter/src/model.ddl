/**
 * 红外发射端的数据通信逻辑（CT107D 的 LD1 数字支路）。
 *
 * 只建模「载波是否开启」这一位：`mod` 引脚为高或宿主通过 `setCarrier(true)` 提交请求
 * 时，`carrier` 输出为真。两者是逻辑或，方便在 mod 未接线时由测试夹具直接注入；高电平
 * 必须由外部驱动，悬空按未调制处理。载波状态变化才发布，重复请求不重复发事件。
 *
 * 供电由真实 `vcc`/`gnd` 采样决定。掉电时 `carrier` 强制为假，恢复供电后若请求仍
 * 有效则重新为真。没有光电、正向电流、波长、发光强度、38 kHz 模拟波形、光路或协议
 * 状态机；具体脉宽/帧语义由连接两端的测试夹具定义，不属于本器件。
 */
device IrEmitter(
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert lowThreshold >= 0 && lowThreshold <= 5,
    "lowThreshold must be within 0..5 V";
  assert highThreshold > lowThreshold && highThreshold <= 5,
    "highThreshold must be above lowThreshold and within 5 V";

  /** 数字调制输入；高电平表示载波开启。 */
  pin mod(low: lowThreshold, high: highThreshold);
  pin vcc(low: lowThreshold, high: highThreshold);
  pin gnd(low: lowThreshold, high: highThreshold);

  input channel request: bool(capacity: 8, overflow: Overflow.error);
  output channel carrier: bool(capacity: 16, overflow: Overflow.drop_oldest);

  /** 宿主通过 setCarrier 提交的逻辑请求；与 mod 引脚相或。 */
  state hostRequest: bool = false;
  /** 已发布给宿主的载波状态，用于抑制启动阶段的重复事件。 */
  state reportedCarrier: bool = false;

  pure fn isHigh(level: Logic) -> bool {
    return level == Logic.high;
  }

  pure fn isLow(level: Logic) -> bool {
    return level == Logic.low;
  }

  /** 只有 VCC 确定拉高且 GND 确定拉低时才认为器件获得供电。 */
  derived powered: bool = isHigh(vcc.sample.level) && isLow(gnd.sample.level);
  /** mod 引脚上的数字调制电平；未知按未调制处理。 */
  derived modulation: bool = isHigh(mod.sample.level);
  /** 对外可见的逻辑载波。 */
  derived carrierState: bool = powered && (hostRequest || modulation);

  process start {
    reportedCarrier = carrierState;
    carrier.send(carrierState);
    // 启动过程同时是该通道的唯一消费者。
    loop {
      hostRequest = await request.receive();
    }
  }

  process changed on carrierState {
    if reportedCarrier != carrierState {
      reportedCarrier = carrierState;
      carrier.send(carrierState);
    }
  }
}
