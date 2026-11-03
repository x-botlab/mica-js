// The trigger has a 1 Mohm pull-down; remaining unknown samples mean low.
// Uses the reaction contract for trigger changes.
// Simultaneous expiry and retriggering follow stable queue order.
// The deadline worker is event-driven and does not poll.
device RetriggerableMonostable(
  pulseWidth: number default 10000,
  outputResistance: number default 25,
  lowThreshold: number default 0.8,
  highThreshold: number default 2.0
) {
  const maxTime = 7_200_000_000_000_000;
  assert isInteger(pulseWidth) && pulseWidth > 0 && pulseWidth <= maxTime,
    "pulseWidth must be a positive supported duration";
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000,
    "outputResistance must be within the supported range";

  pin trigger(low: lowThreshold, high: highThreshold) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin q;
  pin supply;
  pin reference;

  derived triggerHigh: bool = trigger.sample.level == Logic.high;

  state active: bool = false;
  state deadline: number = 0;

  process start {
    if active {
      q.intent <- [resistor(to: supply, resistance: outputResistance)];
    } else {
      q.intent <- [resistor(to: reference, resistance: outputResistance)];
    }
  }

  reaction triggerChanged on triggerHigh as (previous, current) {
    if !previous && current {
      const nextDeadline = now() + pulseWidth;
      assert isSafeInteger(nextDeadline) && nextDeadline <= maxTime,
        "pulse deadline exceeds the supported time range";
      deadline = nextDeadline;
      active = true;
      q.intent <- [resistor(to: supply, resistance: outputResistance)];
    }
  }

  process expire on active {
    if !active {
      return;
    }
    loop {
      const remaining = deadline - now();
      if remaining == 0 {
        active = false;
        q.intent <- [resistor(to: reference, resistance: outputResistance)];
        return;
      }
      await ticks(remaining);
    }
  }
}
