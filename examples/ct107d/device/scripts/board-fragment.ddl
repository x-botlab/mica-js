// Board glue for the fused CT107D model. Placeholders are filled by scripts/generate.mjs.

  record SwitchEvent {
    index: number;
    pressed: bool;
  }
  record JumperEvent {
    index: number;
    closed: bool;
  }
  record AmplifierEvent {
    field: number;
    value: number;
  }
  record Lm324Input {
    field: number;
    value: number;
  }
  record LedSignal {
    index: number;
    brightness: number;
    current: number;
    voltage: number;
  }
  record DisplaySignal {
    designator: number;
    digit1: number;
    digit2: number;
    digit3: number;
    digit4: number;
  }
  record SwitchSignal {
    index: number;
    pressed: bool;
  }
  record ActuatorSignal {
    target: number;
    active: bool;
    value: number;
  }
  record JumperSignal {
    index: number;
    closed: bool;
  }
  record AmplifierSignal {
    position: number;
    gain: number;
    outputVoltage: number;
  }

  /** Matrix keys and independent keys, indexed by the schematic designator. */
  memory keyStates[24];
  /** J13 CON3: true = 2-3 (WR grounded, default IO); false = 1-2 (WR follows P42). */
  state j13Closed: bool = {{J13_CLOSED}};
  /** J5 CON3: true = 2-3 (S4-S7 grounded, default independent); false = 1-2 (P44 column). */
  state j5Closed: bool = {{J5_CLOSED}};
  state j3Closed: bool = {{J3_CLOSED}};
  state j2Vs1838: bool = {{J2_VS1838}};

  input channel switchEvent: SwitchEvent(capacity: 32, overflow: Overflow.drop_oldest);
  input channel jumperEvent: JumperEvent(capacity: 16, overflow: Overflow.drop_oldest);
  input channel amplifierEvent: AmplifierEvent(capacity: 16, overflow: Overflow.drop_oldest);
  input channel lm324Input: Lm324Input(capacity: 16, overflow: Overflow.drop_oldest);

  output channel led: LedSignal(capacity: 256, overflow: Overflow.drop_oldest);
  output channel display: DisplaySignal(capacity: 32, overflow: Overflow.drop_oldest);
  output channel switch: SwitchSignal(capacity: 32, overflow: Overflow.drop_oldest);
  output channel actuator: ActuatorSignal(capacity: 32, overflow: Overflow.drop_oldest);
  output channel jumper: JumperSignal(capacity: 16, overflow: Overflow.drop_oldest);
  output channel amplifier: AmplifierSignal(capacity: 32, overflow: Overflow.drop_oldest);

  /** Last committed seven-segment masks, per display and digit. */
  state ds1Digit1: number = 0;
  state ds1Digit2: number = 0;
  state ds1Digit3: number = 0;
  state ds1Digit4: number = 0;
  state ds2Digit1: number = 0;
  state ds2Digit2: number = 0;
  state ds2Digit3: number = 0;
  state ds2Digit4: number = 0;
  state ds1Candidate1: number = 0;
  state ds1Candidate2: number = 0;
  state ds1Candidate3: number = 0;
  state ds1Candidate4: number = 0;
  state ds2Candidate1: number = 0;
  state ds2Candidate2: number = 0;
  state ds2Candidate3: number = 0;
  state ds2Candidate4: number = 0;
  state ds1Since1: number = 0;
  state ds1Since2: number = 0;
  state ds1Since3: number = 0;
  state ds1Since4: number = 0;
  state ds2Since1: number = 0;
  state ds2Since2: number = 0;
  state ds2Since3: number = 0;
  state ds2Since4: number = 0;
  state ds1Active1: bool = false;
  state ds1Active2: bool = false;
  state ds1Active3: bool = false;
  state ds1Active4: bool = false;
  state ds2Active1: bool = false;
  state ds2Active2: bool = false;
  state ds2Active3: bool = false;
  state ds2Active4: bool = false;

  /** LM324 / RB4 folded analog front-end. */
  state lm324Wiper: number = {{LM324_WIPER}};
  state lm324Position: number = {{LM324_WIPER}};
  state lm324InPlus: number = 0;
  state lm324InMinus: number = 0;
  state lm324Out: number = 0;
  state lm324Gain: number =
    1 + 2 * {{LM324_FEEDBACK}} /
      ({{LM324_MIN_POT}} + ({{LM324_POT}} - {{LM324_MIN_POT}}) * (1 - {{LM324_WIPER}}));

  /** Model output snapshots needed by event publication. */
  state ledMask: number = 0;
  state ledsInitialized: bool = false;
  state relayEnergized: bool = false;
  state buzzerActive: bool = false;
  state actuatorsInitialized: bool = false;

  // ---------------------------------------------------------------------------------------
  // Wiring refresh
  // ---------------------------------------------------------------------------------------

{{DRIVE_STATES}}

{{DRIVE_SETTERS}}

{{BUTTON_FUNCTION}}

{{NET_FUNCTIONS}}

  fn fusedRefresh() {
    fusedComputeButtons();
    fusedRefreshBody();
    publishLeds();
    publishActuators();
  }

  process fusedWireRefresh on fusedSeq {
    fusedRefresh();
  }

  // ---------------------------------------------------------------------------------------
  // Board observables
  // ---------------------------------------------------------------------------------------

  pure fn fusedBit(value: number, bit: number) -> bool {
    return ((value >> bit) & 1) == 1;
  }

  fn publishLeds() {
    let bits = 0;
    let ready = true;
    if fusedNet{{NET_L1}}() == 0 { bits = bits | 1; }
    else if fusedNet{{NET_L1}}() == 2 { ready = false; }
    if fusedNet{{NET_L2}}() == 0 { bits = bits | 2; }
    else if fusedNet{{NET_L2}}() == 2 { ready = false; }
    if fusedNet{{NET_L3}}() == 0 { bits = bits | 4; }
    else if fusedNet{{NET_L3}}() == 2 { ready = false; }
    if fusedNet{{NET_L4}}() == 0 { bits = bits | 8; }
    else if fusedNet{{NET_L4}}() == 2 { ready = false; }
    if fusedNet{{NET_L5}}() == 0 { bits = bits | 16; }
    else if fusedNet{{NET_L5}}() == 2 { ready = false; }
    if fusedNet{{NET_L6}}() == 0 { bits = bits | 32; }
    else if fusedNet{{NET_L6}}() == 2 { ready = false; }
    if fusedNet{{NET_L7}}() == 0 { bits = bits | 64; }
    else if fusedNet{{NET_L7}}() == 2 { ready = false; }
    if fusedNet{{NET_L8}}() == 0 { bits = bits | 128; }
    else if fusedNet{{NET_L8}}() == 2 { ready = false; }
    // Do not publish a fabricated off state before the latch has driven all LED nets.
    if !ready { return; }
    if bits == ledMask && ledsInitialized { return; }
    ledMask = bits;
    ledsInitialized = true;
    const current = bits == 0 ? 0 : {{LED_CURRENT}};
    const voltage = bits == 0 ? 0 : {{LED_VOLTAGE}};
    const brightness = bits == 0 ? 0 : {{LED_BRIGHTNESS}};
    led.send({ index: 0, brightness: fusedBit(bits, 0) ? brightness : 0, current: fusedBit(bits, 0) ? current : 0, voltage: fusedBit(bits, 0) ? voltage : 0 });
    led.send({ index: 1, brightness: fusedBit(bits, 1) ? brightness : 0, current: fusedBit(bits, 1) ? current : 0, voltage: fusedBit(bits, 1) ? voltage : 0 });
    led.send({ index: 2, brightness: fusedBit(bits, 2) ? brightness : 0, current: fusedBit(bits, 2) ? current : 0, voltage: fusedBit(bits, 2) ? voltage : 0 });
    led.send({ index: 3, brightness: fusedBit(bits, 3) ? brightness : 0, current: fusedBit(bits, 3) ? current : 0, voltage: fusedBit(bits, 3) ? voltage : 0 });
    led.send({ index: 4, brightness: fusedBit(bits, 4) ? brightness : 0, current: fusedBit(bits, 4) ? current : 0, voltage: fusedBit(bits, 4) ? voltage : 0 });
    led.send({ index: 5, brightness: fusedBit(bits, 5) ? brightness : 0, current: fusedBit(bits, 5) ? current : 0, voltage: fusedBit(bits, 5) ? voltage : 0 });
    led.send({ index: 6, brightness: fusedBit(bits, 6) ? brightness : 0, current: fusedBit(bits, 6) ? current : 0, voltage: fusedBit(bits, 6) ? voltage : 0 });
    led.send({ index: 7, brightness: fusedBit(bits, 7) ? brightness : 0, current: fusedBit(bits, 7) ? current : 0, voltage: fusedBit(bits, 7) ? voltage : 0 });
  }

  fn publishActuators() {
    const relay = fusedNet{{NET_N_RELAY}}() == 0;
    const buzzer = fusedNet{{NET_N_BUZZ}}() == 0;
    if !actuatorsInitialized || relay != relayEnergized {
      relayEnergized = relay;
      actuator.send({ target: 0, active: relay, value: 0 });
    }
    if !actuatorsInitialized || buzzer != buzzerActive {
      buzzerActive = buzzer;
      actuator.send({ target: 1, active: buzzer, value: 0 });
    }
    actuatorsInitialized = true;
  }

  pure fn segmentMask() -> number {
    let mask = 0;
    if fusedNet{{NET_A}}() == {{SEG_LIT_LEVEL}} { mask = mask | 1; }
    if fusedNet{{NET_B}}() == {{SEG_LIT_LEVEL}} { mask = mask | 2; }
    if fusedNet{{NET_C}}() == {{SEG_LIT_LEVEL}} { mask = mask | 4; }
    if fusedNet{{NET_D}}() == {{SEG_LIT_LEVEL}} { mask = mask | 8; }
    if fusedNet{{NET_E}}() == {{SEG_LIT_LEVEL}} { mask = mask | 16; }
    if fusedNet{{NET_F}}() == {{SEG_LIT_LEVEL}} { mask = mask | 32; }
    if fusedNet{{NET_G}}() == {{SEG_LIT_LEVEL}} { mask = mask | 64; }
    if fusedNet{{NET_DP}}() == {{SEG_LIT_LEVEL}} { mask = mask | 128; }
    return mask;
  }

  record Scan {
    active: bool;
    mask: number;
  }

  derived ds1Scan1: Scan = { active: fusedNet{{NET_COM1}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };
  derived ds1Scan2: Scan = { active: fusedNet{{NET_COM2}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };
  derived ds1Scan3: Scan = { active: fusedNet{{NET_COM3}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };
  derived ds1Scan4: Scan = { active: fusedNet{{NET_COM4}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };
  derived ds2Scan1: Scan = { active: fusedNet{{NET_COM5}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };
  derived ds2Scan2: Scan = { active: fusedNet{{NET_COM6}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };
  derived ds2Scan3: Scan = { active: fusedNet{{NET_COM7}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };
  derived ds2Scan4: Scan = { active: fusedNet{{NET_COM8}}() == {{SEG_SELECT_LEVEL}}, mask: segmentMask() };

  reaction trackDs1Digit1 on ds1Scan1 as (previous, current) {
    ds1Active1 = current.active;
    ds1Candidate1 = current.mask;
    ds1Since1 = now();
  }
  reaction trackDs1Digit2 on ds1Scan2 as (previous, current) {
    ds1Active2 = current.active;
    ds1Candidate2 = current.mask;
    ds1Since2 = now();
  }
  reaction trackDs1Digit3 on ds1Scan3 as (previous, current) {
    ds1Active3 = current.active;
    ds1Candidate3 = current.mask;
    ds1Since3 = now();
  }
  reaction trackDs1Digit4 on ds1Scan4 as (previous, current) {
    ds1Active4 = current.active;
    ds1Candidate4 = current.mask;
    ds1Since4 = now();
  }
  reaction trackDs2Digit1 on ds2Scan1 as (previous, current) {
    ds2Active1 = current.active;
    ds2Candidate1 = current.mask;
    ds2Since1 = now();
  }
  reaction trackDs2Digit2 on ds2Scan2 as (previous, current) {
    ds2Active2 = current.active;
    ds2Candidate2 = current.mask;
    ds2Since2 = now();
  }
  reaction trackDs2Digit3 on ds2Scan3 as (previous, current) {
    ds2Active3 = current.active;
    ds2Candidate3 = current.mask;
    ds2Since3 = now();
  }
  reaction trackDs2Digit4 on ds2Scan4 as (previous, current) {
    ds2Active4 = current.active;
    ds2Candidate4 = current.mask;
    ds2Since4 = now();
  }

  fn emitDisplay1() {
    display.send({ designator: 0, digit1: ds1Digit1, digit2: ds1Digit2, digit3: ds1Digit3, digit4: ds1Digit4 });
  }
  fn emitDisplay2() {
    display.send({ designator: 1, digit1: ds2Digit1, digit2: ds2Digit2, digit3: ds2Digit3, digit4: ds2Digit4 });
  }

  process scanDs1Digit1 on ds1Scan1 {
    if ds1Scan1.active {
      const stableAt = ds1Since1 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds1Scan1.active && ds1Active1 && ds1Candidate1 == ds1Scan1.mask && now() - ds1Since1 >= {{SEG_SETTLE_PS}} && ds1Digit1 != ds1Candidate1 {
        ds1Digit1 = ds1Candidate1;
        emitDisplay1();
      }
    }
  }
  process scanDs1Digit2 on ds1Scan2 {
    if ds1Scan2.active {
      const stableAt = ds1Since2 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds1Scan2.active && ds1Active2 && ds1Candidate2 == ds1Scan2.mask && now() - ds1Since2 >= {{SEG_SETTLE_PS}} && ds1Digit2 != ds1Candidate2 {
        ds1Digit2 = ds1Candidate2;
        emitDisplay1();
      }
    }
  }
  process scanDs1Digit3 on ds1Scan3 {
    if ds1Scan3.active {
      const stableAt = ds1Since3 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds1Scan3.active && ds1Active3 && ds1Candidate3 == ds1Scan3.mask && now() - ds1Since3 >= {{SEG_SETTLE_PS}} && ds1Digit3 != ds1Candidate3 {
        ds1Digit3 = ds1Candidate3;
        emitDisplay1();
      }
    }
  }
  process scanDs1Digit4 on ds1Scan4 {
    if ds1Scan4.active {
      const stableAt = ds1Since4 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds1Scan4.active && ds1Active4 && ds1Candidate4 == ds1Scan4.mask && now() - ds1Since4 >= {{SEG_SETTLE_PS}} && ds1Digit4 != ds1Candidate4 {
        ds1Digit4 = ds1Candidate4;
        emitDisplay1();
      }
    }
  }
  process scanDs2Digit1 on ds2Scan1 {
    if ds2Scan1.active {
      const stableAt = ds2Since1 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds2Scan1.active && ds2Active1 && ds2Candidate1 == ds2Scan1.mask && now() - ds2Since1 >= {{SEG_SETTLE_PS}} && ds2Digit1 != ds2Candidate1 {
        ds2Digit1 = ds2Candidate1;
        emitDisplay2();
      }
    }
  }
  process scanDs2Digit2 on ds2Scan2 {
    if ds2Scan2.active {
      const stableAt = ds2Since2 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds2Scan2.active && ds2Active2 && ds2Candidate2 == ds2Scan2.mask && now() - ds2Since2 >= {{SEG_SETTLE_PS}} && ds2Digit2 != ds2Candidate2 {
        ds2Digit2 = ds2Candidate2;
        emitDisplay2();
      }
    }
  }
  process scanDs2Digit3 on ds2Scan3 {
    if ds2Scan3.active {
      const stableAt = ds2Since3 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds2Scan3.active && ds2Active3 && ds2Candidate3 == ds2Scan3.mask && now() - ds2Since3 >= {{SEG_SETTLE_PS}} && ds2Digit3 != ds2Candidate3 {
        ds2Digit3 = ds2Candidate3;
        emitDisplay2();
      }
    }
  }
  process scanDs2Digit4 on ds2Scan4 {
    if ds2Scan4.active {
      const stableAt = ds2Since4 + {{SEG_SETTLE_PS}};
      if now() < stableAt { await ticks(stableAt - now()); }
      if ds2Scan4.active && ds2Active4 && ds2Candidate4 == ds2Scan4.mask && now() - ds2Since4 >= {{SEG_SETTLE_PS}} && ds2Digit4 != ds2Candidate4 {
        ds2Digit4 = ds2Candidate4;
        emitDisplay2();
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Digital input/analog glue
  // ---------------------------------------------------------------------------------------

  process consumeSwitches on fusedStarted {
    loop {
      const event = await switchEvent.receive();
      if event.index < 0 || event.index >= 24 { continue; }
      const level = event.pressed ? 1 : 0;
      if load8(keyStates, event.index) == level { continue; }
      store8(keyStates, event.index, level);
      switch.send({ index: event.index, pressed: event.pressed });
      fusedSeq = fusedSeq + 1;
    }
  }

  process consumeJumpers on fusedStarted {
    loop {
      const event = await jumperEvent.receive();
      if event.index == 0 { j13Closed = event.closed; }
      else if event.index == 1 { j3Closed = event.closed; }
      else if event.index == 2 { j2Vs1838 = event.closed; }
      else if event.index == 3 { j5Closed = event.closed; }
      else { continue; }
      jumper.send({ index: event.index, closed: event.closed });
      fusedSeq = fusedSeq + 1;
    }
  }

  process consumeAmplifier on fusedStarted {
    loop {
      const event = await amplifierEvent.receive();
      if event.field == 0 { lm324Wiper = event.value; }
      fusedAmplifier();
    }
  }

  process consumeLm324Input on fusedStarted {
    loop {
      const event = await lm324Input.receive();
      if event.field == 0 { lm324InPlus = event.value; }
      else if event.field == 1 { lm324InMinus = event.value; }
      fusedAmplifier();
    }
  }

  fn fusedAmplifier() {
    const effective = {{LM324_MIN_POT}} + ({{LM324_POT}} - {{LM324_MIN_POT}}) * (1 - lm324Wiper);
    const nextGain = 1 + 2 * {{LM324_FEEDBACK}} / effective;
    let target = nextGain * (lm324InPlus - lm324InMinus);
    if target < 0 { target = 0; }
    if target > 5 { target = 5; }
    const changed = lm324Position != lm324Wiper || lm324Gain != nextGain || lm324Out != target;
    lm324Position = lm324Wiper;
    lm324Gain = nextGain;
    lm324Out = target;
    if changed {
      amplifier.send({ position: lm324Position, gain: lm324Gain, outputVoltage: target });
    }
  }

  // ---------------------------------------------------------------------------------------
  // Board start and refresh expansion
  // ---------------------------------------------------------------------------------------

  process start {
    fusedStarted = true;
    // STC15 reset ports are quasi-bidirectional with weak pull-ups. The generator reads
    // every P0-P4 pin's initial intent from the standalone MCU DDL and emits the drive
    // list once here, so the fused reset cannot drift from the source package. A first
    // `MOV A,P3` / `MOV A,P4` sees the real reset level; a strong external low still wins
    // in fusedNet. Release (4) is only for later open-drain/input modes.
{{MCU_RESET_DRIVES}}
    {{START_FLAGS}}
    fusedRefresh();
    emitDisplay1();
    emitDisplay2();
    // Publish the same initial idle state as the discrete board devices.
    let key = 0;
    while key < 17 {
      switch.send({ index: key, pressed: false });
      key = key + 1;
    }
    jumper.send({ index: 0, closed: j13Closed });
    jumper.send({ index: 1, closed: j3Closed });
    jumper.send({ index: 2, closed: j2Vs1838 });
    jumper.send({ index: 3, closed: j5Closed });
    amplifier.send({ position: lm324Position, gain: lm324Gain, outputVoltage: lm324Out });
  }

  fn fusedRefreshBody() {
{{FUSED_REFRESH_BODY}}
  }
