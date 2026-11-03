// Static RST-contract trial, not a runtime implementation or chip replica.
// Sixteen zero-initialized bytes; fixed 7-bit slave address 0x50, MSB first.
// The wire address byte is 0xa0 for write and 0xa1 for read.
// Supports address+W, one full word-address byte (0x00..0x0f only), ONE data
// byte, STOP. Word addresses 0x10..0xff are NACKed, not masked or wrapped;
// that transaction is then ignored until START/STOP.
// STOP starts a 1 ms busy interval, then commits that byte. After the FIRST
// data byte's ACK, mode becomes ignore: all extra bytes are ignored, their
// ninth clocks stay released (NACK), and STOP still commits the FIRST byte.
// This is not whole-transaction rejection or page/sequential write support.
// Repeated START discards an uncommitted byte, not a busy write.
// Address-only writes set the pointer for repeated-START reads. Reads continue
// across bytes on master ACK; pointer wraps at 16 after each transmitted byte.
// Master NACK ends transmission. Every address is NACKed while busy.
// No pages, persistence after board recreation, write protection, stretch,
// arbitration, electrical timing enforcement or power-loss model.
// Assembly MUST explicitly wire supply/reference to ideal 3.3 V/0 V and
// provide EXTERNAL pull-ups on BOTH SDA and SCL (e.g. 4.7 kohm to supply).
// supply is an assembly terminal, never an SDA drive target. The slave only
// sinks SDA through 25 ohm or releases it with []; it never drives SCL.
// SCL's 1 Mohm input pull-down is a sample choice, not an I2C requirement.
// The authorized pin initializer is creation-time intent before the factory,
// with a same-instance forward pin reference; it is not yet normative RST.
// SDA has no internal pull: released means exactly []. External pull-ups must
// actually resolve high; floating/unknown is NOT treated as an idle high.
// Raw samples are captured at every bus-code event. Codes preserve unknown;
// only level==Logic.high is high, remaining unknown is interpreted as low
// by sample policy (including data and master ACK), not electrical truth.
// Legal stimulus separates SDA setup from SCL rising and publishes every edge.
// START/STOP require SCL high in BOTH old/new samples. They precede clock
// handling, a sample priority choice, not a new core scheduling rule.
// Own ACK/data sink changes occur only on SCL falling edges. Their resulting
// SDA publications keep SCL low in both snapshots, so they are neither
// START/STOP nor clock edges. ACK is asserted after bit 8 falls, held across
// clock 9 rising, and released after clock 9 falls (read bit 7 may then sink).
// This relies on the declared legal stimulus: publish the falling-edge/SDA
// response before raising SCL again; simultaneous high-clock SDA changes are
// intentionally decoded as START/STOP, not repaired by a source-origin hack.
// Only the writer process waits, once per busy interval; bus reactions keep
// servicing edges during that wait. No polling or await inside reactions.
// Awaiting acceptance: zero/current/random reads; wrong-address NACK; byte
// ACK low only across the ninth clock; single-byte STOP commit and pre-deadline
// NACK/post-deadline ACK; repeated START without STOP; read ACK continuation,
// NACK termination and 15->0 wrap; invalid word address/extra-byte NACK;
// external-pull-up omission/unknown decode; start after an earlier reaction
// must preserve any already-established SDA sink and protocol state.
device I2cEeprom {
  enum Mode { idle, receiveByte, slaveAck, transmitByte, masterAck, ignore }
  enum ReceiveStage { slaveAddress, wordAddress, dataByte }
  record BusCodes { clockCode: number; dataCode: number; }

  pin scl(low: 0.8, high: 2.0) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin sda(low: 0.8, high: 2.0);
  pin supply;
  pin reference;
  memory storage[16];

  state mode: Mode = Mode.idle;
  state receiveStage: ReceiveStage = ReceiveStage.slaveAddress;
  state nextMode: Mode = Mode.ignore;
  state received: number = 0;
  state receiveBits: number = 0;
  state acknowledge: bool = false;
  state ackPhase: number = 0;
  state pointer: number = 0;
  state transmitted: number = 0;
  state transmitBit: number = 7;
  state masterAccepted: bool = false;
  state masterAckSampled: bool = false;
  state sinking: bool = false;
  state staged: bool = false;
  state stagedAddress: number = 0;
  state stagedData: number = 0;
  state busy: bool = false;

  pure fn code(raw: sample) -> number {
    if raw.level == Logic.high {
      return 1;
    } else if raw.level == Logic.low {
      return 0;
    }
    return 2;
  }

  derived busCodes: BusCodes = {
    clockCode: code(scl.sample),
    dataCode: code(sda.sample)
  };

  fn publishSda() {
    if sinking {
      sda.intent <- [resistor(to: reference, resistance: 25)];
    } else {
      sda.intent <- [];
    }
  }

  fn sink(enabled: bool) {
    sinking = enabled;
    publishSda();
  }

  fn beginTransmit() {
    transmitted = load8(storage, pointer);
    transmitBit = 7;
    mode = Mode.transmitByte;
    sink(((transmitted >> transmitBit) & 1) == 0);
  }

  fn finishReceivedByte() {
    acknowledge = false;
    nextMode = Mode.ignore;
    if receiveStage == ReceiveStage.slaveAddress {
      if (received >> 1) == 0x50 && !busy {
        acknowledge = true;
        if (received & 1) == 1 {
          nextMode = Mode.transmitByte;
        } else {
          receiveStage = ReceiveStage.wordAddress;
          nextMode = Mode.receiveByte;
        }
      }
    } else if receiveStage == ReceiveStage.wordAddress {
      if received < 16 {
        pointer = received;
        acknowledge = true;
        receiveStage = ReceiveStage.dataByte;
        nextMode = Mode.receiveByte;
      }
    } else {
      stagedAddress = pointer;
      stagedData = received;
      staged = true;
      acknowledge = true;
      // Exactly one accepted data byte; further clocks see released NACK.
      nextMode = Mode.ignore;
    }
    mode = Mode.slaveAck;
    ackPhase = 0;
  }

  process start {
    // Reapply only the current output, never reset reaction-owned state.
    publishSda();
  }

  process writeCycle on busy {
    if !busy {
      return;
    }
    const writeAddress = stagedAddress;
    const writeData = stagedData;
    await ticks(1_000_000_000);
    store8(storage, writeAddress, writeData);
    pointer = (writeAddress + 1) % 16;
    busy = false;
    // busy=false may queue a harmless run which returns above. Bus events
    // do not wake this sleep or replace its saved address/data.
  }

  reaction busEdge on busCodes as (previous, current)
    capture rawClock = scl.sample, rawData = sda.sample {
    const clockHigh = current.clockCode == 1;
    const clockWasHigh = previous.clockCode == 1;
    const dataHigh = current.dataCode == 1;
    const dataWasHigh = previous.dataCode == 1;

    if clockWasHigh && clockHigh && dataWasHigh && !dataHigh {
      mode = Mode.receiveByte;
      receiveStage = ReceiveStage.slaveAddress;
      received = 0;
      receiveBits = 0;
      staged = false;
      sink(false);
    } else if clockWasHigh && clockHigh && !dataWasHigh && dataHigh {
      if staged && !busy {
        busy = true;
      }
      staged = false;
      mode = Mode.idle;
      sink(false);
    } else if !clockWasHigh && clockHigh {
      if mode == Mode.receiveByte {
        received = (received << 1) | (dataHigh ? 1 : 0);
        receiveBits = receiveBits + 1;
        if receiveBits == 8 {
          finishReceivedByte();
        }
      } else if mode == Mode.slaveAck && ackPhase == 1 {
        ackPhase = 2;
      } else if mode == Mode.masterAck {
        masterAccepted = !dataHigh;
        masterAckSampled = true;
      }
    } else if clockWasHigh && !clockHigh {
      if mode == Mode.slaveAck {
        if ackPhase == 0 {
          sink(acknowledge);
          ackPhase = 1;
        } else if ackPhase == 2 {
          sink(false);
          if nextMode == Mode.transmitByte {
            beginTransmit();
          } else {
            mode = nextMode;
            received = 0;
            receiveBits = 0;
          }
        }
      } else if mode == Mode.transmitByte {
        if transmitBit > 0 {
          transmitBit = transmitBit - 1;
          sink(((transmitted >> transmitBit) & 1) == 0);
        } else {
          pointer = (pointer + 1) % 16;
          mode = Mode.masterAck;
          masterAckSampled = false;
          sink(false);
        }
      } else if mode == Mode.masterAck && masterAckSampled {
        if masterAccepted {
          beginTransmit();
        } else {
          mode = Mode.ignore;
          sink(false);
        }
      }
    }
  }
}
