device Led() {
  pin anode = [resistor(to: cathode, resistance: 1000)];
  pin cathode;
  output channel brightness: number(capacity: 64);
  fn report() {
    const a = anode.sample.voltage;
    const k = cathode.sample.voltage;
    if a != none && k != none {
      brightness.send(max(0, min(1, (a - k) / 5)));
    } else {
      brightness.send(0);
    }
  }
  process start { report(); }
  reaction anodeChanged on anode.sample.voltage as (previous, next) { report(); }
  reaction cathodeChanged on cathode.sample.voltage as (previous, next) { report(); }
}
