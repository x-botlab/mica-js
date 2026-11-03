// Static RST-contract trial, not a runtime implementation or chip replica.
// Four zero-initialized bytes; 2 address bits a0..a1 select 0..3,
// 8 bidirectional data bits d0..d7 encode 0..255; a0/d0 are least significant.
// selected, writeEnable and outputEnable are active HIGH sample choices.
// Write takes priority over read. A write commits when the selected/write
// window closes, using THAT boundary's current published address/data.
// previous determines only whether the selected/write window was open.
// Opening the window releases all data outputs; allow that release to publish
// before closing, so a prior SRAM read drive is absent from the closing sample.
// Address/data changes published together with window closure ARE sampled.
// If the external driver also releases at closure, the actual solved sample
// is used (including unknown-to-zero decode), not an invented old data value.
// All reaction captures precede all bodies; the closing write happens before
// this reaction publishes any read output for the current address/controls.
// Closing and reopening within one publication produces no observed edge.
// Address/data changes inside an open write window do not themselves commit.
// No access delay, setup/hold enforcement, power gating or contention fault.
// Address/control inputs use sample-selected 1 Mohm weak pull-downs.
// This pin initializer is authorized creation-time initial intent, not yet
// normative RST syntax; reference is this instance's forward-referenced pin.
// Initial branches exist before the JS factory. No new core rule is implied.
// Data pins have no pull-down: disabled/read-blocked output is exactly [].
// Only Logic.high decodes as one; remaining unknown decodes as zero by sample
// policy, not electrical truth. Captures preserve raw samples for each event.
// Wire supply/reference explicitly to ideal 3.3 V/0 V assembly networks.
// Awaiting acceptance: zero reads at all four addresses; write/read 0x00,
// 0xa5 and 0xff; independent addresses; window close by either control;
// write-over-read priority; disabled high-Z; unknown input decode; startup
// after an earlier instance reaction must not overwrite stored bytes.
device AsynchronousSram {
  record Bus {
    address: number;
    data: number;
    selected: bool;
    writing: bool;
    outputEnabled: bool;
  }

  pin a0(low: 0.8, high: 2.0) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin a1(low: 0.8, high: 2.0) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin selected(low: 0.8, high: 2.0) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin writeEnable(low: 0.8, high: 2.0) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin outputEnable(low: 0.8, high: 2.0) =
    [resistor(to: reference, resistance: 1_000_000)];
  pin d0(low: 0.8, high: 2.0);
  pin d1(low: 0.8, high: 2.0);
  pin d2(low: 0.8, high: 2.0);
  pin d3(low: 0.8, high: 2.0);
  pin d4(low: 0.8, high: 2.0);
  pin d5(low: 0.8, high: 2.0);
  pin d6(low: 0.8, high: 2.0);
  pin d7(low: 0.8, high: 2.0);
  pin supply;
  pin reference;
  memory storage[4];

  pure fn bit(raw: sample) -> number {
    return raw.level == Logic.high ? 1 : 0;
  }

  derived bus: Bus = {
    address: bit(a0.sample) + 2 * bit(a1.sample),
    data: bit(d0.sample) + 2 * bit(d1.sample) +
      4 * bit(d2.sample) + 8 * bit(d3.sample) +
      16 * bit(d4.sample) + 32 * bit(d5.sample) +
      64 * bit(d6.sample) + 128 * bit(d7.sample),
    selected: selected.sample.level == Logic.high,
    writing: writeEnable.sample.level == Logic.high,
    outputEnabled: outputEnable.sample.level == Logic.high
  };

  fn driveBit(target: pin, value: number, enabled: bool) {
    if !enabled {
      target.intent <- [];
    } else if value == 1 {
      target.intent <- [resistor(to: supply, resistance: 25)];
    } else {
      target.intent <- [resistor(to: reference, resistance: 25)];
    }
  }

  fn publish(valueBus: Bus) {
    const enabled = valueBus.selected && !valueBus.writing &&
      valueBus.outputEnabled;
    const value = load8(storage, valueBus.address);
    driveBit(d0, value & 1, enabled);
    driveBit(d1, (value >> 1) & 1, enabled);
    driveBit(d2, (value >> 2) & 1, enabled);
    driveBit(d3, (value >> 3) & 1, enabled);
    driveBit(d4, (value >> 4) & 1, enabled);
    driveBit(d5, (value >> 5) & 1, enabled);
    driveBit(d6, (value >> 6) & 1, enabled);
    driveBit(d7, (value >> 7) & 1, enabled);
  }

  process start {
    publish(bus);
  }

  reaction access on bus as (previous, current)
    capture rawA0 = a0.sample, rawA1 = a1.sample,
      rawSelected = selected.sample, rawWrite = writeEnable.sample,
      rawOutput = outputEnable.sample,
      rawD0 = d0.sample, rawD1 = d1.sample, rawD2 = d2.sample,
      rawD3 = d3.sample, rawD4 = d4.sample, rawD5 = d5.sample,
      rawD6 = d6.sample, rawD7 = d7.sample {
    if previous.selected && previous.writing &&
      !(current.selected && current.writing) {
      store8(storage, current.address, current.data);
    }
    publish(current);
  }
}
