/**
 * 两脚抽象常开轻触开关。
 *
 * 按下时在 `a`、`b` 之间建立 1 Ω 有限电阻支路；松开时移除该支路，让两端保持悬空。
 * 移除而不是用 1 GΩ “假断开”，符合统一器件模型“断开即移除支路”的电气合同。
 * 这是把真实四脚轻触开关抽象成两端的行为模型，二维图也只绘制两端。
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
