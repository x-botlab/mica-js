/** Fixed CT117E-M4 digital MCU/LCD bus. Runtime code and model are self-contained. */
device Ct117eM4(clockFrequency: number default 80000000, refreshRate: number default 60) {
  pin VSS1;
  pin VDD1;
  assert isFinite(clockFrequency) && clockFrequency >= 1000 && clockFrequency <= 170000000,
    "clockFrequency must be a finite value within 1000..170000000";
  memory code[0x20000];
  memory sram[0x5800];
  memory ccm[0x2800];
  memory periph[0x1000];
  memory sys[0x200];
  state r0: number = 0;
  state r1: number = 0;
  state r2: number = 0;
  state r3: number = 0;
  state r4: number = 0;
  state r5: number = 0;
  state r6: number = 0;
  state r7: number = 0;
  state r8: number = 0;
  state r9: number = 0;
  state r10: number = 0;
  state r11: number = 0;
  state r12: number = 0;
  state sp: number = 0;
  state lr: number = 0xffffffff;
  state apsr: number = 0x01000000;
  state primask: number = 0;
  state pc: number = 0;
  state pendingPs: number = 0;
  state tickPs: number = 1000000000000;
  state tickActive: bool = false;
  state serviceMask: number = 0;
  state serviceResume: number = 0;
  state pollContinue: bool = false;
  state gpioSync: number = 0;
  state gpioPinMask: number = 0;
  state gpioPowered: bool = false;
  state gpioWrite: number = 0;
  state gpioWriteAddr: number = 0;
  state gpioWriteValue: number = 0;
  state gpioWriteSize: number = 4;
  state deferRead: bool = false;
  state deferReadPort: number = 0;
  state deferReadOffset: number = 0;
  state deferReadTarget: number = 0;
  state deferReadSize: number = 4;
  state deferReadSigned: bool = false;
  state deferWrite: bool = false;
  state deferWriteAddr: number = 0;
  state deferWriteValue: number = 0;
  state deferWriteSize: number = 4;
  state gpioModer0: number = 0;
  state gpioModer1: number = 0;
  state gpioModer2: number = 0;
  state gpioModer3: number = 0;
  state gpioModer4: number = 0;
  state gpioOtyper0: number = 0;
  state gpioOtyper1: number = 0;
  state gpioOtyper2: number = 0;
  state gpioOtyper3: number = 0;
  state gpioOtyper4: number = 0;
  state gpioPupdr0: number = 0;
  state gpioPupdr1: number = 0;
  state gpioPupdr2: number = 0;
  state gpioPupdr3: number = 0;
  state gpioPupdr4: number = 0;
  state gpioAfr00: number = 0;
  state gpioAfr01: number = 0;
  state gpioAfr02: number = 0;
  state gpioAfr03: number = 0;
  state gpioAfr04: number = 0;
  state gpioAfr10: number = 0;
  state gpioAfr11: number = 0;
  state gpioAfr12: number = 0;
  state gpioAfr13: number = 0;
  state gpioAfr14: number = 0;
  state gpioOdr0: number = 0;
  state gpioOdr1: number = 0;
  state gpioOdr2: number = 0;
  state gpioOdr3: number = 0;
  state gpioOdr4: number = 0;
  state irqDirty: bool = false;
  state systickOn: bool = false;
  state txMask: number = 0;
  state systickCtrl: number = 0;
  state systickLoad: number = 0;
  state systickVal: number = 0;
  state systickCount: number = 0;
  state systickPending: number = 0;
  state tx1Active: number = 0;
  state tx1Remaining: number = 0;
  state tx1Queue: number = 0;
  state tx1Count: number = 0;
  state tx1Period: number = 1;
  state tx1Publish: number = -1;
  state tx2Active: number = 0;
  state tx2Remaining: number = 0;
  state tx2Queue: number = 0;
  state tx2Count: number = 0;
  state tx2Period: number = 1;
  state tx2Publish: number = -1;
  state tx3Active: number = 0;
  state tx3Remaining: number = 0;
  state tx3Queue: number = 0;
  state tx3Count: number = 0;
  state tx3Period: number = 1;
  state tx3Publish: number = -1;
  state itState: number = 0;
  state halted: bool = false;
  state faultPc: number = 0;
  output channel fault: number(capacity: 16);
  output channel uart1Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel uart2Tx: number(capacity: 64, overflow: Overflow.drop_oldest);
  output channel uart3Tx: number(capacity: 64, overflow: Overflow.drop_oldest);

  pure fn halDelayPoll() -> bool {
    return serviceMask != 0 || pollContinue || txMask != 0 || !systickOn;
  }
  fn halDelayConsume() { pollContinue = false; }
  pure fn halDelayWaitPs() -> number {
    if !systickOn || txMask != 0 || serviceMask != 0 || pollContinue { return 0; }
    const remaining = tickPs - pendingPs;
    return remaining > 0 ? remaining : 1;
  }
  fn halDelayAdvance(elapsedPs: number) {
    if !systickOn || txMask != 0 || elapsedPs <= 0 { return; }
    const remaining = tickPs - pendingPs;
    if elapsedPs < remaining { return; }
    pendingPs = 0;
    systickVal = systickLoad;
    systickCount = 1;
    if (systickCtrl & 2) != 0 {
      systickPending = 1;
      irqDirty = true;
      if primask == 0 {
        pollContinue = true;
        serviceResume = pc;
        serviceMask = serviceMask | 16;
        pc = 0x20000;
      }
    }
  }
  process start {
    reset(false);
    sp = load32le(code, 0);
    lr = 0xffffffff;
    pc = load32le(code, 4) & 0xfffffffe;
  }

  assert isFinite(refreshRate) && refreshRate >= 1 && refreshRate <= 240,
    "refreshRate must be a finite value within 1..240";
  const PANEL_WIDTH = 320;
  const PANEL_HEIGHT = 240;
  const GRAM_WIDTH = 240;
  const GRAM_HEIGHT = 320;
  const MAX_BODY_BYTES = PANEL_WIDTH * PANEL_HEIGHT * 2;
  const FRAME_PERIOD_PS = round(1_000_000_000_000 / refreshRate);
  record FrameRect { x: number; y: number; width: number; height: number; }
  memory gram[PANEL_WIDTH * PANEL_HEIGHT * 2];
  memory regs[512];
  state index: number = 0;
  state entryMode: number = 0x1030;
  state addrX: number = 0;
  state addrY: number = 0;
  state windowX0: number = 0;
  state windowX1: number = GRAM_WIDTH - 1;
  state windowY0: number = 0;
  state windowY1: number = GRAM_HEIGHT - 1;
  state dirty: bool = false;
  state dirtyX0: number = 0;
  state dirtyX1: number = 0;
  state dirtyY0: number = 0;
  state dirtyY1: number = 0;
  state scheduled: bool = false;
  state frameSeq: number = 0;
  output channel frameInfo: FrameRect(capacity: 4096, overflow: Overflow.error);
  output channel frameRows: bytes(maxLength: MAX_BODY_BYTES, capacity: 4096,
                                  overflow: Overflow.error);
  derived readActive: bool = fusedWire19 == 0 && fusedWire18 == 0 && 1 != 0;
  fn dataBus() -> number {
    return (fusedWire0 == 1 ? 1 : 0) +
      2 * (fusedWire1 == 1 ? 1 : 0) +
      4 * (fusedWire2 == 1 ? 1 : 0) +
      8 * (fusedWire3 == 1 ? 1 : 0) +
      16 * (fusedWire4 == 1 ? 1 : 0) +
      32 * (fusedWire5 == 1 ? 1 : 0) +
      64 * (fusedWire6 == 1 ? 1 : 0) +
      128 * (fusedWire7 == 1 ? 1 : 0) +
      256 * (fusedWire8 == 1 ? 1 : 0) +
      512 * (fusedWire9 == 1 ? 1 : 0) +
      1024 * (fusedWire10 == 1 ? 1 : 0) +
      2048 * (fusedWire11 == 1 ? 1 : 0) +
      4096 * (fusedWire12 == 1 ? 1 : 0) +
      8192 * (fusedWire13 == 1 ? 1 : 0) +
      16384 * (fusedWire14 == 1 ? 1 : 0) +
      32768 * (fusedWire15 == 1 ? 1 : 0);
  }
  fn advanceAddress() {
    const xUp = (entryMode & 16) != 0;
    const yUp = (entryMode & 32) != 0;
    if (entryMode & 8) == 0 {
      addrX = addrX + (xUp ? 1 : -1);
      if addrX > windowX1 {
        addrX = windowX0;
        addrY = addrY + (yUp ? 1 : -1);
        if addrY > windowY1 { addrY = windowY0; }
        else if addrY < windowY0 { addrY = windowY1; }
      } else if addrX < windowX0 {
        addrX = windowX1;
        addrY = addrY + (yUp ? 1 : -1);
        if addrY > windowY1 { addrY = windowY0; }
        else if addrY < windowY0 { addrY = windowY1; }
      }
    } else {
      addrY = addrY + (yUp ? 1 : -1);
      if addrY > windowY1 {
        addrY = windowY0;
        addrX = addrX + (xUp ? 1 : -1);
        if addrX > windowX1 { addrX = windowX0; }
        else if addrX < windowX0 { addrX = windowX1; }
      } else if addrY < windowY0 {
        addrY = windowY1;
        addrX = addrX + (xUp ? 1 : -1);
        if addrX > windowX1 { addrX = windowX0; }
        else if addrX < windowX0 { addrX = windowX1; }
      }
    }
  }
  fn writeCommand(value: number) { index = value & 0xff; }
  fn writeData(value: number) {
    if index == 0x22 {
      let x = addrX;
      let y = addrY;
      const x0 = windowX0;
      const x1 = windowX1;
      const y0 = windowY0;
      const y1 = windowY1;
      const mode = entryMode;
      const stride = PANEL_WIDTH;
      if x >= x0 && x <= x1 && y >= y0 && y <= y1 &&
          x < GRAM_WIDTH && y < GRAM_HEIGHT {
        const column = stride - 1 - y;
        store16le(gram, (x * stride + column) * 2, value);
        fusedGramStores = fusedGramStores + 1;
        if dirty {
          if column < dirtyX0 { dirtyX0 = column; }
          else if column > dirtyX1 { dirtyX1 = column; }
          if x < dirtyY0 { dirtyY0 = x; }
          else if x > dirtyY1 { dirtyY1 = x; }
        } else {
          dirty = true;
          dirtyX0 = column;
          dirtyX1 = column;
          dirtyY0 = x;
          dirtyY1 = x;
        }
        if !scheduled {
          scheduled = true;
          fusedFramePending = true;
        }
      }
      if (mode & 8) == 0 {
        x = x + ((mode & 16) != 0 ? 1 : -1);
        if x > x1 || x < x0 {
          x = x > x1 ? x0 : x1;
          y = y + ((mode & 32) != 0 ? 1 : -1);
          if y > y1 { y = y0; }
          else if y < y0 { y = y1; }
          addrY = y;
        }
        addrX = x;
      } else {
        y = y + ((mode & 32) != 0 ? 1 : -1);
        if y > y1 || y < y0 {
          y = y > y1 ? y0 : y1;
          x = x + ((mode & 16) != 0 ? 1 : -1);
          if x > x1 { x = x0; }
          else if x < x0 { x = x1; }
          addrX = x;
        }
        addrY = y;
      }
    } else {
      store16le(regs, index * 2, value);
      if index == 0x20 {
        addrX = value & 0xff;
        store16le(regs, index * 2, addrX);
      } else if index == 0x21 {
        addrY = value & 0x1ff;
        store16le(regs, index * 2, addrY);
      } else if index == 0x03 {
        entryMode = value;
      } else if index == 0x50 {
        const next = value & 0xff;
        if next <= windowX1 { windowX0 = next; }
        store16le(regs, index * 2, windowX0);
      } else if index == 0x51 {
        const next = value & 0xff;
        if next >= windowX0 && next < GRAM_WIDTH { windowX1 = next; }
        store16le(regs, index * 2, windowX1);
      } else if index == 0x52 {
        const next = value & 0x1ff;
        if next <= windowY1 { windowY0 = next; }
        store16le(regs, index * 2, windowY0);
      } else if index == 0x53 {
        const next = value & 0x1ff;
        if next >= windowY0 && next < GRAM_HEIGHT { windowY1 = next; }
        store16le(regs, index * 2, windowY1);
      }
    }
  }
  fn readValue() -> number {
    let fusedResult = 0;
    if fusedWire17 != 1 { fusedResult = 0; }
    else if index == 0x00 { fusedResult = 0x9325; }
    else if index == 0x20 { fusedResult = addrX; }
    else if index == 0x21 { fusedResult = addrY; }
    else if index == 0x22 {
      const value = load16le(gram,
        (addrX * PANEL_WIDTH + (PANEL_WIDTH - 1) - addrY) * 2);
      advanceAddress();
      fusedResult = value;
    } else { fusedResult = load16le(regs, index * 2); }
    return fusedResult;
  }
  fn driveData(value: number) {
    fusedReadValue = value;
    fusedReading = true;
  }
  fn releaseData() { fusedReading = false; }
  fn clearGram() {
    let offset = 0;
    while offset < PANEL_WIDTH * PANEL_HEIGHT * 2 {
      store16le(gram, offset, 0);
      offset = offset + 2;
    }
  }
  fn reset(clearPixels: bool) {
    index = 0;
    entryMode = 0x1030;
    addrX = 0;
    addrY = 0;
    windowX0 = 0;
    windowX1 = GRAM_WIDTH - 1;
    windowY0 = 0;
    windowY1 = GRAM_HEIGHT - 1;
    let reg = 0;
    while reg < 512 {
      store8(regs, reg, 0);
      reg = reg + 1;
    }
    store16le(regs, 0x03 * 2, entryMode);
    store16le(regs, 0x20 * 2, addrX);
    store16le(regs, 0x21 * 2, addrY);
    store16le(regs, 0x50 * 2, windowX0);
    store16le(regs, 0x51 * 2, windowX1);
    store16le(regs, 0x52 * 2, windowY0);
    store16le(regs, 0x53 * 2, windowY1);
    releaseData();
    if clearPixels {
      clearGram();
      dirty = true;
      dirtyX0 = 0;
      dirtyX1 = PANEL_WIDTH - 1;
      dirtyY0 = 0;
      dirtyY1 = PANEL_HEIGHT - 1;
      if !scheduled {
        scheduled = true;
        fusedFramePending = true;
      }
    }
  }
  process publishFrames on frameSeq {
    if dirty {
      await ticks(FRAME_PERIOD_PS);
      const x = dirtyX0;
      const y = dirtyY0;
      const width = dirtyX1 - dirtyX0 + 1;
      const height = dirtyY1 - dirtyY0 + 1;
      const info: FrameRect = { x: x, y: y, width: width, height: height };
      frameInfo.send(info);
      if width == PANEL_WIDTH || height == 1 {
        frameRows.send(copyBytes(gram, (y * PANEL_WIDTH + x) * 2, width * height * 2));
      } else {
        let row = 0;
        while row < height {
          frameRows.send(copyBytes(gram, ((y + row) * PANEL_WIDTH + x) * 2, width * 2));
          row = row + 1;
        }
      }
      dirty = false;
    }
    scheduled = false;
  }

  state fusedWire0: number = -1;
  state fusedWire1: number = -1;
  state fusedWire2: number = -1;
  state fusedWire3: number = -1;
  state fusedWire4: number = -1;
  state fusedWire5: number = -1;
  state fusedWire6: number = -1;
  state fusedWire7: number = -1;
  state fusedWire8: number = -1;
  state fusedWire9: number = -1;
  state fusedWire10: number = -1;
  state fusedWire11: number = -1;
  state fusedWire12: number = -1;
  state fusedWire13: number = -1;
  state fusedWire14: number = -1;
  state fusedWire15: number = -1;
  state fusedWire16: number = -1;
  state fusedWire17: number = -1;
  state fusedWire18: number = -1;
  state fusedWire19: number = -1;
  state fusedWrChanges: number = 0;
  state fusedWrites: number = 0;
  state fusedReading: bool = false;
  state fusedReadValue: number = 0;
  state fusedGramStores: number = 0;
  state fusedFramePending: bool = false;
  state fusedFrameResume: number = 0;
  state fusedFrameDelay: number = 0;
  fn fusedWr(previous: number) {
    const next = fusedWire16;
    if previous != next { fusedWrChanges = fusedWrChanges + 1; }
    if previous == 0 && next == 1 && fusedWire18 == 0 {
      fusedWrites = fusedWrites + 1;
      if fusedWire17 == 0 { writeCommand(dataBus()); }
      else { writeData(dataBus()); }
    }
  }
  fn fusedLevel(wire: number) -> number {
    return wire == 0 ? (fusedReading ? (fusedReadValue >> 0) & 1 : fusedWire0) :
      wire == 1 ? (fusedReading ? (fusedReadValue >> 1) & 1 : fusedWire1) :
      wire == 2 ? (fusedReading ? (fusedReadValue >> 2) & 1 : fusedWire2) :
      wire == 3 ? (fusedReading ? (fusedReadValue >> 3) & 1 : fusedWire3) :
      wire == 4 ? (fusedReading ? (fusedReadValue >> 4) & 1 : fusedWire4) :
      wire == 5 ? (fusedReading ? (fusedReadValue >> 5) & 1 : fusedWire5) :
      wire == 6 ? (fusedReading ? (fusedReadValue >> 6) & 1 : fusedWire6) :
      wire == 7 ? (fusedReading ? (fusedReadValue >> 7) & 1 : fusedWire7) :
      wire == 8 ? (fusedReading ? (fusedReadValue >> 8) & 1 : fusedWire8) :
      wire == 9 ? (fusedReading ? (fusedReadValue >> 9) & 1 : fusedWire9) :
      wire == 10 ? (fusedReading ? (fusedReadValue >> 10) & 1 : fusedWire10) :
      wire == 11 ? (fusedReading ? (fusedReadValue >> 11) & 1 : fusedWire11) :
      wire == 12 ? (fusedReading ? (fusedReadValue >> 12) & 1 : fusedWire12) :
      wire == 13 ? (fusedReading ? (fusedReadValue >> 13) & 1 : fusedWire13) :
      wire == 14 ? (fusedReading ? (fusedReadValue >> 14) & 1 : fusedWire14) :
      wire == 15 ? (fusedReading ? (fusedReadValue >> 15) & 1 : fusedWire15) :
      wire == 16 ? fusedWire16 : wire == 17 ? fusedWire17 :
      wire == 18 ? fusedWire18 : wire == 19 ? fusedWire19 : -1;
  }
  fn fusedReadWindow() {
    const active = fusedWire18 == 0 && fusedWire19 == 0;
    if active && !fusedReading { driveData(readValue()); }
    else if !active && fusedReading { releaseData(); }
  }
}
