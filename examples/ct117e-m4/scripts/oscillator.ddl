  state timerPosition@ID@: number = 0.5;
  state timerLevel@ID@: number = 1;

  process oscillator@ID@ on boardReady {
    let position = timerPosition@ID@;
    let epoch = now();
    let phase = 1;
    loop {
      const deadline = round(epoch + phase * timerHalfPeriod(position));
      await ticks(deadline - now());
      timerLevel@ID@ = 1 - timerLevel@ID@;
      captureBoardEdge(@CAPTURE@, timerLevel@ID@);
      // A change takes effect at the next half-cycle, without cutting this one short.
      if position != timerPosition@ID@ {
        position = timerPosition@ID@;
        epoch = deadline;
        phase = 1;
      } else {
        phase = phase + 1;
      }
    }
  }
