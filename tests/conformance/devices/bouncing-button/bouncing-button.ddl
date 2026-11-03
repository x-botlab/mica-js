// Passive contact; each changed command extends the mechanical settling deadline.
device BouncingButton(
  initialPressed: bool default false,
  onResistance: number default 1,
  bounceDuration: number default 5_000_000_000,
  minInterval: number default 100_000_000,
  maxInterval: number default 500_000_000
) {
  const maxTime = 7_200_000_000_000_000;
  assert onResistance >= 0.001 && onResistance <= 1_000_000_000;
  assert isSafeInteger(bounceDuration) && bounceDuration > 0 && bounceDuration <= maxTime;
  assert isSafeInteger(minInterval) && minInterval > 0;
  assert isSafeInteger(maxInterval) && maxInterval >= minInterval && maxInterval <= bounceDuration;

  pin a = initialPressed ? [resistor(to: b, resistance: onResistance)] : [];
  pin b;
  input channel pressed: bool(capacity: 16, overflow: Overflow.error);
  output notification settled;

  state target: bool = initialPressed;
  state contact: bool = initialPressed;
  state moving: bool = false;
  state deadline: number = 0;

  fn setContact(closed: bool) {
    contact = closed;
    if contact {
      a.intent <- [resistor(to: b, resistance: onResistance)];
    } else {
      a.intent <- [];
    }
  }

  process start {
    loop {
      const requested = await pressed.receive();
      if requested != target {
        const nextDeadline = now() + bounceDuration;
        assert isSafeInteger(nextDeadline) && nextDeadline <= maxTime,
          "button settling deadline exceeds the supported time range";
        target = requested;
        deadline = nextDeadline;
        moving = true;
      }
    }
  }

  process bounce on moving {
    if !moving {
      return;
    }
    loop {
      const remaining = deadline - now();
      if remaining <= 0 {
        setContact(target);
        moving = false;
        settled.notify();
        return;
      }
      setContact(random() < 0.5);
      const interval = minInterval + floor(random() * (maxInterval - minInterval + 1));
      await ticks(min(interval, remaining));
    }
  }
}
