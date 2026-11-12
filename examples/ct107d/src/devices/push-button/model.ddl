/**
 * 常开轻触按键（CT107D 的 S1、S4–S19）。
 *
 * `press` 为 true 时两端 1 Ω 导通，false 时 1 GΩ——用有限电阻而不是断开，保证悬空的
 * 另一端仍被网络引用，电气求解不会出现孤立支路。
 *
 * 理想化：没有抖动、回弹、行程与接触电阻；按下/松开在端口投递的时刻立即生效，
 * 不模拟机械寿命与多键同时按下的优先顺序。
 */
device PushButton {
  pin a = [resistor(to: b, resistance: 1_000_000_000)];
  pin b;
  input channel press: bool(capacity: 64);
  process start {
    loop {
      const pressed = await press.receive();
      a.intent <- [resistor(to: b, resistance: pressed ? 1 : 1_000_000_000)];
    }
  }
}
