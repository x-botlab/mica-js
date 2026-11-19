device ActiveBuzzer() {
  pin positive = [resistor(to: negative, resistance: 1000)];
  pin negative;
  output channel active: bool(capacity: 8, overflow: Overflow.drop_oldest);
  fn report() {
    const p = positive.sample.voltage;
    const n = negative.sample.voltage;
    if p != none && n != none { active.send(p - n >= 2.5); }
    else { active.send(false); }
  }
  process start { report(); }
  reaction positiveChanged on positive.sample.voltage as (previous, next) { report(); }
  reaction negativeChanged on negative.sample.voltage as (previous, next) { report(); }
}
