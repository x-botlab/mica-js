// Deliberately linear and bidirectional: no diode threshold or reverse breakdown.
device Led {
  pin anode = [resistor(to: cathode, resistance: 100)];
  pin cathode;
  output channel brightness: number(capacity: 64);
  output channel current: number(capacity: 64);
  output channel voltage: number(capacity: 64);
  fn report() {
    const a = anode.sample.voltage;
    const c = cathode.sample.voltage;
    if a != none && c != none {
      const v = a - c;
      voltage.send(v);
      current.send(v / 100);
      brightness.send(min(1, max(0, (v / 100) / 0.02)));
    } else {
      voltage.send(0);
      current.send(0);
      brightness.send(0);
    }
  }
  process start { report(); }
  reaction anodeChanged on anode.sample.voltage as (previous, nextVoltage) { report(); }
  reaction cathodeChanged on cathode.sample.voltage as (previous, nextVoltage) { report(); }
}
