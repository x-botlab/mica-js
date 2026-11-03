// Static contract trial, not an executable/runtime implementation.
// 8N1, LSB first, integer ps; bitTime must be even. Connect supply=3.3 V,
// reference=0 V. RX uses 0.8/2.0 V thresholds; only Logic.high means 1.
// Pin initial intents below are explicitly authorized, pending spec incorporation;
// they exist before the first solve and may reference later instance pins.
// TX persistent FIFO: 16 bytes, drop-new per byte; input staging: 8 chunks of <=16.
// RX output FIFO: 16 frames per batch, overflow faults the board.
device TrialUart(bitTime: number default 100000000) {
  assert isSafeInteger(bitTime) && bitTime > 0 && bitTime % 2 == 0;
  pin rx(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1_000_000)];
  pin tx = [resistor(to: supply, resistance: 25)];
  pin supply;
  pin reference;

  record Frame { value: number; framingError: bool; unknown: bool; }
  input channel transmit: bytes(maxLength: 16, capacity: 8, overflow: Overflow.error);
  output channel received: Frame(capacity: 16, overflow: Overflow.error);
  output channel txDropped: number(capacity: 128, overflow: Overflow.error);
  memory txFifo[16];
  state txHead: number = 0;
  state txTail: number = 0;
  state txCount: number = 0;
  state rxBusy: bool = false;
  state rxRequest: bool = false;
  derived rxHigh: bool = rx.sample.level == Logic.high;

  // Dedicated consumer never waits for serial TX: every injected chunk is
  // copied before batch cleanup, even while the independent transmitter sleeps.
  process start {
    loop {
      const chunk = await transmit.receive();
      let index = 0;
      while index < chunk.length {
        if txCount < 16 {
          store8(txFifo, txTail, chunk[index]);
          txTail = (txTail + 1) % 16;
          txCount = txCount + 1;
        } else {
          txDropped.send(chunk[index]);
        }
        index = index + 1;
      }
    }
  }

  fn driveTx(high: bool) {
    if high {
      tx.intent <- [resistor(to: supply, resistance: 25)];
    } else {
      tx.intent <- [resistor(to: reference, resistance: 25)];
    }
  }

  process sendFrames on txCount {
    while txCount > 0 {
      const value = load8(txFifo, txHead);
      txHead = (txHead + 1) % 16;
      txCount = txCount - 1;
      driveTx(false);
      await ticks(bitTime);
      let bit = 0;
      while bit < 8 {
        driveTx(((value >> bit) & 1) == 1);
        await ticks(bitTime);
        bit = bit + 1;
      }
      driveTx(true);
      await ticks(bitTime);
    }
  }

  // Falling edges are latched synchronously. Changes during receive do not
  // preempt its timed waits. No synthesized initial edge and no cycle polling.
  reaction detectStart on rxHigh as (previous, current) {
    if previous && !current && !rxBusy {
      rxBusy = true;
      rxRequest = !rxRequest;
    }
  }

  process receiveFrame on rxRequest {
    await ticks(bitTime / 2);
    const startSample = rx.sample;
    if startSample.level == Logic.high {
      rxBusy = false;
      return;
    }
    let uncertain = startSample.level == Logic.unknown;
    let value = 0;
    let bit = 0;
    while bit < 8 {
      await ticks(bitTime);
      // Preserve the original sample; unknown-to-low is a local digital policy.
      const raw = rx.sample;
      if raw.level == Logic.high { value = value | (1 << bit); }
      uncertain = uncertain || raw.level == Logic.unknown;
      bit = bit + 1;
    }
    await ticks(bitTime);
    const stopSample = rx.sample;
    received.send({ value: value,
      framingError: stopSample.level != Logic.high,
      unknown: uncertain || stopSample.level == Logic.unknown });
    // Release at the stop-bit centre, before the next legal back-to-back start.
    rxBusy = false;
  }
}
