// The control input has a 1 Mohm pull-down; remaining unknown samples mean low.
device ControlledSwitch(
  onResistance: number default 1,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert onResistance >= 0.001 && onResistance <= 1_000_000_000,
    "onResistance must be within the supported range";

  pin a;
  pin b;
  pin control(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin reference;

  fn updateConnection() {
    if control.sample.level == Logic.high {
      a.intent <- [resistor(to: b, resistance: onResistance)];
    } else {
      a.intent <- [];
    }
  }

  process start {
    updateConnection();
  }

  process controlChanged on control.sample.level {
    updateConnection();
  }
}
