// An 8-bit timer with a compare register buffered until counter wrap.
device CounterPwm(
  tickPeriod: number default 1000,
  initialDuty: number default 128,
  outputResistance: number default 25
) {
  const maxTime = 7_200_000_000_000_000;
  assert isSafeInteger(tickPeriod) && tickPeriod > 0 && tickPeriod <= maxTime;
  assert isInteger(initialDuty) && initialDuty >= 0 && initialDuty <= 256;
  assert outputResistance >= 0.001 && outputResistance <= 1_000_000_000;

  pin pwm = initialDuty > 0
    ? [resistor(to: supply, resistance: outputResistance)]
    : [resistor(to: reference, resistance: outputResistance)];
  pin supply;
  pin reference;
  input channel duty: number(capacity: 16, overflow: Overflow.error);
  output notification compared;
  output notification wrapped;
  public memory registers[4];

  state count: number = 0;
  state requestedDuty: number = initialDuty;
  state activeDuty: number = initialDuty;
  state running: bool = false;
  derived pwmHigh: bool = count < activeDuty;

  process start {
    store8(registers, 0, count);
    store16le(registers, 2, activeDuty);
    running = true;
    loop {
      const nextDuty = await duty.receive();
      assert isInteger(nextDuty) && nextDuty >= 0 && nextDuty <= 256,
        "duty must be an integer in [0, 256]";
      requestedDuty = nextDuty;
    }
  }

  process clock on running {
    if !running {
      return;
    }
    loop {
      await ticks(tickPeriod);
      count = (count + 1) % 256;
      if count == 0 {
        activeDuty = requestedDuty;
      }
      store8(registers, 0, count);
      store16le(registers, 2, activeDuty);
    }
  }

  reaction drivePwm on pwmHigh as (previous, current) {
    if current {
      pwm.intent <- [resistor(to: supply, resistance: outputResistance)];
    } else {
      pwm.intent <- [resistor(to: reference, resistance: outputResistance)];
    }
  }

  reaction reportCount on count as (previous, current) {
    if current == 0 {
      wrapped.notify();
    }
    if current == activeDuty {
      compared.notify();
    }
  }
}
