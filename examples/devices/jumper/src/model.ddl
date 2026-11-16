/**
 * 两脚跳线（CT107D 的 J13：WR/IO 模式选择；JS1/JS2 同类）。
 *
 * `closed` 是装配初值：true 时两端 `resistance` 导通；false 时移除 `a` 的支路，两端
 * 保持悬空。符合统一器件合同“断开即移除支路”，不保留有限大假断开电阻。
 *
 * 除实例属性外，运行期还可通过输入通道 `control` 切换状态；当前状态由 `closedState`
 * 通道回传，供交互式跳线展示。切换立即生效，不模拟机械抖动、插拔寿命与接触氧化。
 */
device Jumper(
  closed: bool default true,
  resistance: number default 0.05
) {
  assert isFinite(resistance) && resistance >= 0.001 && resistance <= 1_000_000,
    "resistance must be a finite ohm value within 0.001..1000000";

  pin a;
  pin b;

  /** 交互式闭合控制；level 语义下每个值都表示新的目标状态。 */
  input channel control: bool(capacity: 8, overflow: Overflow.drop_oldest);
  /** 当前闭合状态，供展示订阅。 */
  output channel closedState: bool(capacity: 8, overflow: Overflow.drop_oldest);

  state engaged: bool = closed;

  fn applyState() {
    if engaged {
      a.intent <- [resistor(to: b, resistance: resistance)];
    } else {
      a.intent <- [];
    }
    closedState.send(engaged);
  }

  process start {
    applyState();
    loop {
      engaged = await control.receive();
      applyState();
    }
  }
}
