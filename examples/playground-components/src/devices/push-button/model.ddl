// Finite off resistance keeps both sides referenced when the switch is open.
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
