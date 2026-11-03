// Inputs have 1 Mohm pull-downs; remaining unknown samples mean low.
// Uses the reaction contract for clock and clear changes.
device DFlipFlop(
  initialValue: bool default false,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";

  record Controls { clockCode: number; clearCode: number; }

  pin data(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin clock(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin clear(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin q;
  pin supply;
  pin reference;

  state stored: bool = initialValue;

  pure fn encode(level: Logic) -> number {
    if level == Logic.high {
      return 1;
    }
    return 0;
  }

  derived controls: Controls = {
    clockCode: encode(clock.sample.level),
    clearCode: encode(clear.sample.level)
  };

  fn publishStored() {
    if stored {
      q.intent <- [resistor(to: supply, resistance: outputResistance)];
    } else {
      q.intent <- [resistor(to: reference, resistance: outputResistance)];
    }
  }

  process start {
    if clear.sample.level == Logic.high {
      stored = false;
    }
    publishStored();
  }

  reaction latch on controls as (previous, current)
    capture edgeData = data.sample.level {
    if current.clearCode == 1 {
      stored = false;
    } else if previous.clockCode == 0 && current.clockCode == 1 {
      stored = edgeData == Logic.high;
    }
    publishStored();
  }
}
