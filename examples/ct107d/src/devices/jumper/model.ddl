/**
 * 两脚跳线（CT107D 的 J13：WR 源选择；JS1/JS2 同类）。
 *
 * `closed` 为 true 时两端 0.05 Ω 导通，false 时 1 GΩ 断开——与按键一样用有限电阻而不是
 * 真正断开，保证另一端仍被网络引用，电气求解不会出现孤立支路。
 *
 * 跳线是装配期配置：运行期不变，因此没有输入端口；`closed` 只能在实例属性里给定。
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

  pin a = [resistor(to: b, resistance: closed ? resistance : openResistance)];
  pin b;
}
