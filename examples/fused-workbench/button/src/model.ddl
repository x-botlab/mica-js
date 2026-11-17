device Button() {
  pin a1;
  pin a2 = [resistor(to: a1, resistance: 0.001)];
  pin b1;
  pin b2 = [resistor(to: b1, resistance: 0.001)];
  input channel pressed: bool(capacity: 8, overflow: Overflow.drop_oldest);
  process start {
    loop {
      const value = await pressed.receive();
      if value {
        a1.intent <- [resistor(to: b1, resistance: 1)];
      } else {
        a1.intent <- [];
      }
    }
  }
}
