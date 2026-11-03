// The resistor branch exists before initial sampling.
device Resistor(resistance: number default 10000) {
  assert resistance >= 0.001 && resistance <= 1_000_000_000,
    "resistance must be within the supported range";

  pin a = [resistor(to: b, resistance: resistance)];
  pin b;
}
