// PROTOTYPE: SPI 屏幕 + MCU SPI 外设模型（基准专用）。
import { createDeviceBuilder, types } from '../../../device-model/dist/index.js';

// 320x240 RGB565 SPI panel: 153 600 bytes per frame, 50 MHz SCK, mode 0, MSB first.
// The baseline is a bit-banged hardware SPI peripheral that toggles SCK on every bit;
// the panel is an edge-triggered shift register (`reaction on sckHigh` shifts one bit),
// which is the honest model under the current electrical contract.
export function makeTiming(width = 320, height = 240) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0)
    throw new RangeError('Panel geometry must be positive integers');
  const bitsPerWord = 8;
  const bitTimePs = 20_000; // 50 MHz SCK
  const byteTimePs = bitTimePs * bitsPerWord;
  const rowBytes = width * 2;
  const bytes = rowBytes * height;
  const burstPs = bytes * byteTimePs;
  const framePeriodPs = 33_333_333_333;
  const gapPs = framePeriodPs - burstPs;
  if (gapPs <= 0) throw new RangeError('Panel geometry exceeds one 30 fps frame period');
  return Object.freeze({
    width,
    height,
    rowBytes,
    bytes,
    bitsPerWord,
    bitTimePs,
    byteTimePs,
    burstPs,
    framePeriodPs,
    gapPs,
    frameRateHz: 30,
    sckHz: 1e12 / bitTimePs,
  });
}

export const defaultTiming = makeTiming();

export const nominalFrameRateHz = (timing) => 1e12 / timing.framePeriodPs;
export const frameStartPs = (timing, frame) => frame * timing.framePeriodPs;
export const frameEndPs = (timing, frame) => frameStartPs(timing, frame + 1);
export const burstEndPs = (timing, frame) => frameStartPs(timing, frame) + timing.burstPs;
export const microsPerByte = (timing) => timing.byteTimePs / 1e6;

export const mcuSnapshotFields = Object.freeze(['frame', 'byteIndex', 'framesSent']);
export const screenSnapshotFields = Object.freeze([
  'byteCount',
  'bytesThisFrame',
  'frames',
  'shiftReg',
  'bitCount',
]);
export const signals = Object.freeze(['sck', 'mosi', 'cs', 'dc']);

/**
 * Independent panel oracle. It never runs inside the board and uses a different byte
 * decomposition than the MCU model:
 *   model:  (frame*37 + index*29 + floor(index/rowBytes)*17) & 255
 *   oracle: (frame*37 + row*rowStride + column*29) & 255
 * with rowStride = (rowBytes*29 + 17) mod 256; the two are equivalent because
 * index = row*rowBytes + column.
 */
export function createScreenOracle(timing = defaultTiming) {
  const rowStride = (timing.rowBytes * 29 + 17) & 255;
  const frameCache = new Map();
  const bytesFor = (frame) => {
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new RangeError('Oracle frame must be a non-negative integer');
    let cached = frameCache.get(frame);
    if (cached) return cached;
    const gram = new Uint8Array(timing.bytes);
    let checksum = 0;
    for (let row = 0; row < timing.height; row++)
      for (let column = 0; column < timing.rowBytes; column++) {
        const index = row * timing.rowBytes + column;
        const value = (frame * 37 + row * rowStride + column * 29) & 255;
        gram[index] = value;
        checksum = (checksum + value * ((index % 251) + 1)) % 1_000_003;
      }
    cached = Object.freeze({ gram, checksum });
    frameCache.set(frame, cached);
    return cached;
  };
  return Object.freeze({
    bytes: (frame) => bytesFor(frame).gram.slice(),
    checksum: (frame) => bytesFor(frame).checksum,
    byte: (frame, index) => bytesFor(frame).gram[index],
    frameStartPs: (frame) => frameStartPs(timing, frame),
    burstEndPs: (frame) => burstEndPs(timing, frame),
    frameEndPs: (frame) => frameEndPs(timing, frame),
  });
}

const mcuModels = new Map();
const screenModels = new Map();

function pins(d, initialLow) {
  d.pin({ name: 'supply' });
  d.pin({ name: 'reference' });
  for (const name of signals)
    d.pin({
      name,
      low: 0.8,
      high: 2.0,
      ...(initialLow ? { initial: (b) => b.returnValue(b.resistor('reference', 25)) } : {}),
    });
}
function drive(b, name, highLevel) {
  b.if(
    highLevel,
    (c) => c.writeIntent(name, c.resistor('supply', 25)),
    (c) => c.writeIntent(name, c.resistor('reference', 25)),
  );
}
function levelIs(b, pin, member) {
  const sample = b.readSample(pin);
  b.assert(
    b.not(b.equal(types.logic, b.field(sample, 'level'), types.logic.members.unknown)),
    () => 'SPI pin must be electrically resolved at the sampling edge',
  );
  return b.equal(types.logic, b.field(sample, 'level'), types.logic.members[member]);
}
const isHigh = (b, pin) => levelIs(b, pin, 'high');
const isLow = (b, pin) => levelIs(b, pin, 'low');

/**
 * MCU-side hardware SPI peripheral. With `bus` enabled the per-bit SCK/MOSI loop is
 * replaced by one wait per frame: the host drives the transport burst over that window
 * and the electrical layer only receives the final clock/data levels.
 */
export function mcuModel(timing = defaultTiming, bus = false) {
  const key = `${timing.width}x${timing.height}:${bus ? 1 : 0}`;
  if (mcuModels.has(key)) return mcuModels.get(key);
  const d = createDeviceBuilder();
  d.property({ name: 'bus', type: types.bool, default: false });
  pins(d, true);
  for (const name of ['frame', 'byteIndex', 'bit', 'framesSent', 'shift'])
    d.state({ name, type: types.number, initial: 0 });
  d.memory({ name: 'snapshot', length: mcuSnapshotFields.length * 4, public: true });
  d.notification({ name: 'snapshotRequest', direction: 'input' });
  d.on({ name: 'captureSnapshot', sourcePath: ['snapshotRequest'] }, (b) => {
    mcuSnapshotFields.forEach((name, index) =>
      b.store32le('snapshot', index * 4, b.readState(name, types.number)),
    );
  });
  d.start((b) => {
    b.loop((c) => {
      const frame = c.readState('frame', types.number);
      drive(c, 'cs', false);
      drive(c, 'dc', true);
      c.if(
        c.readProperty('bus', types.bool),
        (f) => f.wait(timing.burstPs),
        (f) => {
          f.writeState('byteIndex', 0);
          f.while(
            (g) => g.lessThan(g.readState('byteIndex', types.number), timing.bytes),
            (g) => {
              const index = g.readState('byteIndex', types.number);
              const row = g.divide(
                g.subtract(index, g.remainder(index, timing.rowBytes)),
                timing.rowBytes,
              );
              g.writeState(
                'shift',
                g.bitAnd(
                  g.add(g.add(g.multiply(frame, 37), g.multiply(index, 29)), g.multiply(row, 17)),
                  255,
                ),
              );
              g.writeState('bit', 0);
              g.while(
                (h) => h.lessThan(h.readState('bit', types.number), timing.bitsPerWord),
                (h) => {
                  drive(h, 'mosi', h.greaterThanOrEqual(h.readState('shift', types.number), 128));
                  h.writeState(
                    'shift',
                    h.bitAnd(h.multiply(h.readState('shift', types.number), 2), 255),
                  );
                  h.wait(timing.bitTimePs / 2);
                  drive(h, 'sck', true);
                  h.wait(timing.bitTimePs / 2);
                  drive(h, 'sck', false);
                  h.writeState('bit', h.add(h.readState('bit', types.number), 1));
                },
              );
              g.writeState('byteIndex', g.add(index, 1));
            },
          );
        },
      );
      drive(c, 'cs', true);
      c.writeState('framesSent', c.add(c.readState('framesSent', types.number), 1));
      c.writeState('frame', c.add(frame, 1));
      c.wait(timing.gapPs);
    });
  });
  const model = d.finish();
  mcuModels.set(key, model);
  return model;
}

/**
 * Edge-triggered SPI panel. Every SCK rising edge shifts one MOSI bit into the current
 * byte; after 8 bits the byte lands in GRAM. CS rising ends the frame and records the
 * received byte count.
 */
export function screenModel(timing = defaultTiming) {
  const key = `${timing.width}x${timing.height}`;
  if (screenModels.has(key)) return screenModels.get(key);
  const d = createDeviceBuilder();
  pins(d, false);
  for (const name of ['byteCount', 'bytesThisFrame', 'frames', 'shiftReg', 'bitCount'])
    d.state({ name, type: types.number, initial: 0 });
  d.memory({ name: 'gram', length: timing.bytes, public: true });
  d.memory({ name: 'snapshot', length: screenSnapshotFields.length * 4, public: true });
  d.derived({ name: 'sckHigh', type: types.bool }, (b) => b.returnValue(isHigh(b, 'sck')));
  d.derived({ name: 'csHigh', type: types.bool }, (b) => b.returnValue(isHigh(b, 'cs')));
  d.derived({ name: 'csLow', type: types.bool }, (b) => b.returnValue(isLow(b, 'cs')));
  d.derived({ name: 'dcHigh', type: types.bool }, (b) => b.returnValue(isHigh(b, 'dc')));
  d.on({ name: 'shift', sourcePath: ['sckHigh'] }, (b) => {
    b.if(b.readDerived('sckHigh', types.bool), (c) => {
      c.if(c.readDerived('csLow', types.bool), (e) => {
        e.assert(e.readDerived('dcHigh', types.bool), () => 'SPI data byte while DC is low');
        const bit = e.local(types.number, 0);
        e.if(isHigh(e, 'mosi'), (f) => f.setLocal(bit, 1));
        e.writeState(
          'shiftReg',
          e.bitOr(e.multiply(e.readState('shiftReg', types.number), 2), e.getLocal(bit)),
        );
        e.writeState('bitCount', e.add(e.readState('bitCount', types.number), 1));
        e.if(
          e.equal(types.number, e.readState('bitCount', types.number), timing.bitsPerWord),
          (f) => {
            const index = f.readState('byteCount', types.number);
            f.assert(f.lessThan(index, timing.bytes), () => 'Panel received more than one frame');
            f.store8('gram', index, f.readState('shiftReg', types.number));
            f.writeState('byteCount', f.add(index, 1));
            f.writeState('shiftReg', 0);
            f.writeState('bitCount', 0);
          },
        );
      });
    });
  });
  d.on({ name: 'frameEnd', sourcePath: ['csHigh'] }, (b) => {
    b.if(b.readDerived('csHigh', types.bool), (c) => {
      c.assert(
        c.equal(types.number, c.readState('byteCount', types.number), timing.bytes),
        () => 'CS rising must follow a complete frame',
      );
      c.writeState('bytesThisFrame', c.readState('byteCount', types.number));
      c.writeState('frames', c.add(c.readState('frames', types.number), 1));
      c.writeState('byteCount', 0);
      c.writeState('shiftReg', 0);
      c.writeState('bitCount', 0);
      c.send('frameDone', c.readState('frames', types.number));
    });
  });
  d.channel({ name: 'frameDone', direction: 'output', type: types.number, capacity: 256 });
  d.notification({ name: 'snapshotRequest', direction: 'input' });
  d.on({ name: 'captureSnapshot', sourcePath: ['snapshotRequest'] }, (b) => {
    screenSnapshotFields.forEach((name, index) =>
      b.store32le('snapshot', index * 4, b.readState(name, types.number)),
    );
  });
  const model = d.finish();
  screenModels.set(key, model);
  return model;
}
