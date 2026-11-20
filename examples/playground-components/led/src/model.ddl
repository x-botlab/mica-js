// Deliberately linear and bidirectional: no diode threshold or reverse breakdown.
device Led(forwardResistance: number default 100, ratedCurrent: number default 0.02) {
  assert isFinite(forwardResistance) && forwardResistance >= 0.001 && forwardResistance <= 1_000_000_000;
  assert isFinite(ratedCurrent) && ratedCurrent >= 0.0001 && ratedCurrent <= 1;
  pin anode = [resistor(to: cathode, resistance: forwardResistance)];
  pin cathode;
  output channel brightness: number(capacity: 64);
  output channel current: number(capacity: 64);
  output channel voltage: number(capacity: 64);
  fn report() {
    const a = anode.sample.voltage;
    const c = cathode.sample.voltage;
    if a != none && c != none {
      const v = a - c;
      const i = v / forwardResistance;
      voltage.send(v);
      current.send(i);
      brightness.send(min(1, max(0, i / ratedCurrent)));
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
