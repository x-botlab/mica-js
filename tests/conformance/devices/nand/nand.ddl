// Inputs have 1 Mohm pull-downs; remaining unknown samples mean low.
// Output changes use fixed inertial delay.
device Nand(
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

  pin a(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin b(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin y;
  pin supply;
  pin reference;

  pure fn evaluate() -> Logic {
    if a.sample.level == Logic.high && b.sample.level == Logic.high {
      return Logic.low;
    }
    return Logic.high;
  }

  derived requested: Logic = evaluate();
  state driven: Logic = Logic.unknown;
  state target: Logic = Logic.unknown;
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

  process start {
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
        if target == Logic.high {
          y.intent <- [resistor(to: supply, resistance: outputResistance)];
        } else {
          y.intent <- [resistor(to: reference, resistance: outputResistance)];
        }
        driven = target;
        pending = false;
        return;
      }
    }
  }
}
