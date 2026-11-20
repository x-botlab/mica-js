  // Board glue. Wire placeholders are resolved from the schematic netlist at build time.
  record BoardControl { kind: number; id: number; value: number; }
  input channel boardControl: BoardControl(capacity: 32, overflow: Overflow.error);
  output channel ledMask: number(capacity: 16, overflow: Overflow.drop_oldest);
  state boardReady: bool = false;
  state boardResetPressed: bool = false;
  derived boardReset: bool = boardResetPressed || NRST.sample.level == Logic.low;
  state buttonMask: number = 0;
  state pot1: number = 0.5; // R37, via J11
  state pot2: number = 0.5; // R38, via J12
  state ledOutputs: number = 0xff; // Q, LEDs off before the first latch operation

  process boardControls on boardReady {
    loop {
      const input = await boardControl.receive();
      if input.kind == 0 {
        const bit = 1 << (input.id - 1);
        buttonMask = input.value != 0 ? buttonMask | bit : buttonMask & ~bit;
      } else if input.kind == 1 {
        if input.id == 1 { pot1 = input.value; }
        else { pot2 = input.value; }
      } else if input.kind == 2 {
        if input.id == 1 { timerPosition1 = input.value; }
        else { timerPosition2 = input.value; }
      } else {
        boardResetPressed = input.value != 0;
      }
    }
  }

  fn boardLatch(previousLe: number) {
    if previousLe == 1 || @WIRE_LED_LE@ == 1 {
      boardUpdateLeds();
    }
  }
  fn boardUpdateLeds() {
    const next = u1_dataByte();
    if next != ledOutputs {
      ledOutputs = next;
      ledMask.send(next ^ 0xff); // OE# is grounded and the LEDs sink current.
    }
  }

  // GPIO-derived intents lose drive strength in the digital lowering. Only an actual
  // output-low can beat the two board pull-ups; GPIO input/internal pull does not.
  fn i2cHostLow(bit: number, level: number) -> bool {
    return level == 0 && ((gpioModer1 >> (bit * 2)) & 3) == 1 && ((gpioOdr1 >> bit) & 1) == 0;
  }
  state i2cClock: number = 1;
  state i2cData: number = 1;
  fn boardI2c() {
    const clock = i2cHostLow(@SCL_BIT@, @WIRE_I2C_SCL@) ? 0 : 1;
    const hostData = i2cHostLow(@SDA_BIT@, @WIRE_I2C_SDA@) ? 0 : 1;
    const data = u2_sinking || u3_sinking ? 0 : hostData;
    const previousData = i2cData;
    const previousClock = i2cClock;
    if clock != previousClock || data != previousData {
      u2_busEdge({ clockCode: previousClock, dataCode: previousData },
                 { clockCode: clock, dataCode: data });
      u3_busEdge({ clockCode: previousClock, dataCode: previousData },
                 { clockCode: clock, dataCode: data });
      // A slave's SDA change is part of this edge, not a new START/STOP.
      i2cData = u2_sinking || u3_sinking ? 0 : hostData;
      i2cClock = clock;
    }
  }

  fn boardButton(bit: number, gpio: number) -> number {
    return (buttonMask & bit) != 0 || gpio == 0 ? 0 : 1;
  }
  fn boardAnalog(wire: number) -> number {
    if wire == -2 || wire == -3 { return 3.3; } // VDDA / J17 → VREF+
    if wire == @POT1@ { return 3.3 * pot1; }
    if wire == @POT2@ { return 3.3 * pot2; }
    if wire == @WIPER@ {
      const resistance = u3_resistanceFor(u3_wiperCode);
      return 3.3 * resistance / (10_000 + resistance); // R17 and J15/J16 closed
    }
    return 0;
  }
  pure fn boardAnalogStatus(wire: number) -> SampleStatus {
    return wire == -2 || wire == -3 || wire == @POT1@ || wire == @POT2@ || wire == @WIPER@
      ? SampleStatus.valid : SampleStatus.floating;
  }
  fn boardLevel(wire: number) -> number {
    if wire == @LED_LE@ { return @WIRE_LED_LE@; }
    if wire == @SW1@ { return boardButton(1, @WIRE_SW1@); }
    if wire == @SW2@ { return boardButton(2, @WIRE_SW2@); }
    if wire == @SW3@ { return boardButton(4, @WIRE_SW3@); }
    if wire == @SW4@ { return boardButton(8, @WIRE_SW4@); }
    if wire == @I2C_SCL@ { return i2cClock; }
    if wire == @I2C_SDA@ { return i2cData; }
    if wire == @TIMER1@ { return timerLevel1; }
    if wire == @TIMER2@ { return timerLevel2; }
    if boardAnalogStatus(wire) == SampleStatus.valid {
      const voltage = boardAnalog(wire);
      return voltage >= 2.0 ? 1 : voltage <= 0.8 ? 0 : -1;
    }
    return -1;
  }

  /** OUT feeds TRIG/THRES through R31/R32 + R39/R40; DISCH is not used. */
  pure fn timerHalfPeriod(position: number) -> number {
    return 0.6931471805599453 * (100 + position * 10_000) * 100_000;
  }

  // TIM capture FIFO is shared with the MCU service. Keep the actual edge time even
  // if it occurs during a CPU timing batch or WFI. Ignore unarmed inputs.
  fn captureBoardEdge(pinId: number, level: number) {
    if halted || captureOverflow != 0 || !captureArmed(pinId) { return; }
    if captureTail - captureHead >= 64 {
      captureOverflow = 1;
      faultPc = 0xffffffff;
      halted = true;
      fault.send(0xffffffff);
      return;
    }
    const at = (captureTail % 64) * 16;
    const time = now();
    store32le(captureFifo, at, time % 4294967296);
    store32le(captureFifo, at + 4, floor(time / 4294967296));
    store8(captureFifo, at + 8, pinId);
    store8(captureFifo, at + 9, level);
    captureTail = captureTail + 1;
    // Queue service before the next firmware block (which may read/write TIM),
    // not at its tail: synchronizing the timer there could overtake this edge.
    if pc != 0x20008 {
      captureResume = pc;
      pc = 0x20008;
    }
  }
