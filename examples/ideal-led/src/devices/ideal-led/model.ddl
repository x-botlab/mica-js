device IdealLed {
  pin anode(low: 0.8, high: 2.0);
  pin cathode;
  output channel brightness: number(capacity: 1, overflow: Overflow.drop_oldest);

  process start {
    loop {
      const level = anode.sample.level;
      if level == Logic.high {
        brightness.send(1);
      } else {
        brightness.send(0);
      }
      await ticks(500_000_000);
    }
  }
}
