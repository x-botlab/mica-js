/**
 * 两脚抽象常开轻触开关（CT107D 的 S1、S4–S19）。
 *
 * 这是把真实四脚轻触开关的两组触点抽象成两端的行为模型，不是四脚封装：按下时在 `a`、`b`
 * 之间建立 1 Ω 有限电阻支路，松开时移除该支路，让两端保持悬空。移除而不是用 1 GΩ
 * “假断开”，符合统一器件模型“断开即移除支路”的电气合同，也避免松开的按键继续漏电。
 *
 * 理想化：没有抖动、回弹、行程与接触电阻；按下/松开在通道消息被消费时立即生效，
 * 不模拟机械寿命与多键同时按下的优先顺序。
 */
device PushButton {
  pin a;
  pin b;

  input channel press: bool(capacity: 64);
  output channel pressed: bool(capacity: 64, overflow: Overflow.drop_oldest);

  state engaged: bool = false;

  fn apply() {
    if engaged {
      a.intent <- [resistor(to: b, resistance: 1)];
    } else {
      a.intent <- [];
    }
    pressed.send(engaged);
  }

  process start {
    apply();
    loop {
      engaged = await press.receive();
      apply();
    }
  }
}
