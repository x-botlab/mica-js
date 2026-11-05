device Resistor(resistance: number default 330) {
  assert isFinite(resistance) && resistance >= 0.001 && resistance <= 1_000_000_000;
  pin a = [resistor(to: b, resistance: resistance)];
  pin b;
}
