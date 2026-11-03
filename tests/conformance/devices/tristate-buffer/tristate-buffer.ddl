// Inputs have 1 Mohm pull-downs; remaining unknown samples mean low.
// Output changes use fixed inertial delay.
device TristateBuffer(
  propagationDelay: number default 0,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const maxTime = 7_200_000_000_000_000;
  assert isInteger(propagationDelay) && propagationDelay >= 0 && propagationDelay <= maxTime,
    "propagationDelay must be a supported duration";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";

  enum Drive { released, low, high }

  pin data(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin enable(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin y;
  pin supply;
  pin reference;

  pure fn evaluate() -> Drive {
    if enable.sample.level != Logic.high {
      return Drive.released;
    }
    if data.sample.level == Logic.high {
      return Drive.high;
    }
    return Drive.low;
  }

  derived requested: Drive = evaluate();
  state driven: Drive = Drive.released;
  state target: Drive = Drive.released;
  state pending: bool = false;
  state deadline: number = 0;

  fn requestOutput() {
    if requested == driven {
      target = requested;
      pending = false;
    } else {
      const nextDeadline = now() + propagationDelay;
      assert isSafeInteger(nextDeadline) && nextDeadline <= maxTime,
        "propagation deadline exceeds the supported time range";
      target = requested;
      deadline = nextDeadline;
      pending = true;
    }
  }

  fn publishTarget() {
    match target {
      Drive.released => { y.intent <- []; }
      Drive.low => {
        y.intent <- [resistor(to: reference, resistance: outputResistance)];
      }
      Drive.high => {
        y.intent <- [resistor(to: supply, resistance: outputResistance)];
      }
    }
  }

  process start {
    y.intent <- [];
    requestOutput();
  }

  process resultChanged on requested {
    requestOutput();
  }

  process commitOutput on pending {
    if !pending {
      return;
    }
    loop {
      if !pending {
        return;
      }
      const remaining = deadline - now();
      if remaining > 0 {
        await ticks(remaining);
      } else {
        publishTarget();
        driven = target;
        pending = false;
        return;
      }
    }
  }
}
