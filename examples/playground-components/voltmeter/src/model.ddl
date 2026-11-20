// A finite 10 Mohm input loads the measured circuit slightly.
device Voltmeter {
  pin positive = [resistor(to: negative, resistance: 10_000_000)];
  pin negative;
  output channel voltage: number(capacity: 64);
  fn report() {
    const p = positive.sample.voltage;
    const n = negative.sample.voltage;
    if p != none && n != none { voltage.send(p - n); }
    else { voltage.send(0); }
  }
  process start { report(); }
  reaction positiveChanged on positive.sample.voltage as (previous, current) { report(); }
  reaction negativeChanged on negative.sample.voltage as (previous, current) { report(); }
}
