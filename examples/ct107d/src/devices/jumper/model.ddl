/**
 * 两脚跳线（CT107D 的 J13：WR/IO 模式选择；JS1/JS2 同类）。
 *
 * `closed` 是装配初值：true 时两端 0.05 Ω 导通，false 时 1 GΩ 断开——与按键一样用有限
 * 电阻而不是真正断开，保证另一端仍被网络引用，电气求解不会出现孤立支路。
 *
 * 除实例属性外，运行期还可通过输入端口 `control` 切换状态；当前状态由 `closedState`
 * 端口回传，供交互式跳线 widget 显示。切换立即生效，不模拟机械抖动、插拔寿命与接触氧化。
 */
device Jumper(
  closed: bool default true,
  resistance: number default 0.05,
  openResistance: number default 1_000_000_000
) {
  assert isFinite(resistance) && resistance >= 0.001 && resistance <= 1_000_000,
    "resistance must be a finite ohm value within 0.001..1000000";
  assert isFinite(openResistance) && openResistance > resistance
      && openResistance <= 1_000_000_000_000,
    "openResistance must be finite, greater than resistance and within 1e12";

  pin a;
  pin b;

  /** 交互式闭合控制；level 语义下每个值都表示新的目标状态。 */
  input channel control: bool(capacity: 8, overflow: Overflow.drop_oldest);
  /** 当前闭合状态，供 widget 订阅。 */
  output channel closedState: bool(capacity: 8, overflow: Overflow.drop_oldest);

  state engaged: bool = closed;

  fn applyState() {
    a.intent <- [
      resistor(to: b, resistance: engaged ? resistance : openResistance),
    ];
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
