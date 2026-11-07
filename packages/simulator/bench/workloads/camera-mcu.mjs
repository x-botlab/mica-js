import { createDeviceBuilder, types } from '../../../device-model/dist/index.js';

// 44x64 8-bit parallel camera, 30 fps, 1 MHz PCLK, and a synthetic nominal-100 MHz
// MCU with a DCMI-style capture unit and DMA. All times are integer picoseconds.
//
// Frame structure (one full period including all blanking):
//   VSYNC high (1 ms), 64 lines of 505 us, vertical back porch 13.333333 us.
// Each line: HREF high, 44 pixels at 1 us (data setup in the first half, PCLK
// rising edge in the middle, falling edge at the pixel boundary), HREF low and
// 461 us horizontal blanking.
export const timing = Object.freeze({
  width: 44,
  height: 64,
  pixels: 44 * 64,
  threshold: 100,
  mcuHz: 100_000_000,
  cyclePs: 10_000,
  pclkHz: 1_000_000,
  pixelPs: 1_000_000,
  frameRateHz: 30,
  framePeriodPs: 33_333_333_333,
  startPs: 1_000_000_000,
  vsyncPs: 1_000_000_000,
  linePeriodPs: 505_000_000,
  hblankPs: 505_000_000 - 44 * 1_000_000,
  verticalBlankPs: 33_333_333_333 - 1_000_000_000 - 64 * 505_000_000,
  dmaPs: 20_000,
  irqEntryCycles: 12,
  isrExitCycles: 12,
  frameSetupCycles: 1,
  pixelCycles: 6,
  publishCycles: 2,
});
if (
  timing.linePeriodPs * timing.height + timing.vsyncPs + timing.verticalBlankPs !==
  timing.framePeriodPs
)
  throw new Error('Camera frame timing must add up to the full frame period');
if (timing.hblankPs <= 0 || timing.verticalBlankPs < 0)
  throw new Error('Camera blanking must be non-negative and horizontal active time must fit');
if (timing.pixels !== timing.width * timing.height)
  throw new Error('Camera pixel geometry mismatch');

export const nominalFrameRateHz = 1e12 / timing.framePeriodPs;
export const snapshotFields = Object.freeze([
  'dmaIndex',
  'dmaFrames',
  'framesStarted',
  'processingFrame',
  'index',
  'black',
  'processed',
  'pc',
  'pending',
  'busy',
]);
export const signals = Object.freeze([
  'vsync',
  'href',
  'pclk',
  ...Array.from({ length: 8 }, (_, bit) => `d${bit}`),
]);

export const frameStartPs = (frame) => timing.startPs + frame * timing.framePeriodPs;
export const frameEndPs = (frame) => frameStartPs(frame + 1);
export const rowStartPs = (frame, row) =>
  frameStartPs(frame) + timing.vsyncPs + row * timing.linePeriodPs;
export const pixelRisePs = (frame, row, column) =>
  rowStartPs(frame, row) + column * timing.pixelPs + timing.pixelPs / 2;
export const pixelRiseAtPs = (frame, index) =>
  pixelRisePs(frame, Math.floor(index / timing.width), index % timing.width);
export const lastPixelRisePs = (frame) => pixelRisePs(frame, timing.height - 1, timing.width - 1);
export const lastDmaPs = (frame, dmaPs = timing.dmaPs) => lastPixelRisePs(frame) + dmaPs;
// Entry (12) + frame setup (1) + one instruction per pixel (6) reach results.send
// before the two-cycle publish tail.
export const resultsIssueCycles =
  timing.irqEntryCycles + timing.frameSetupCycles + timing.pixels * timing.pixelCycles;

/**
 * Independent camera/capture oracle. It never runs inside the board and uses a
 * different pixel decomposition than the camera model:
 *   model:  (frame*37 + (row*44+column)*29 + row*17) & 255
 *   oracle: (frame*37 + row*13 + column*29) & 255
 * The two are equivalent because (44*29 + 17) mod 256 = 13.
 */
export function createCameraOracle() {
  const threshold = timing.threshold;
  const frameCache = new Map();
  const frameBytes = (frame) => {
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new RangeError('Oracle frame must be a non-negative integer');
    let cached = frameCache.get(frame);
    if (cached) return cached;
    const raw = new Uint8Array(timing.pixels);
    const binary = new Uint8Array(timing.pixels);
    let black = 0;
    for (let row = 0; row < timing.height; row++) {
      for (let column = 0; column < timing.width; column++) {
        const index = row * timing.width + column;
        const value = (frame * 37 + row * 13 + column * 29) & 255;
        raw[index] = value;
        if (value < threshold) {
          binary[index] = 0;
          black++;
        } else binary[index] = 1;
      }
    }
    cached = Object.freeze({ raw, binary, black });
    frameCache.set(frame, cached);
    return cached;
  };
  return Object.freeze({
    threshold,
    // Copies keep the cached pattern immutable for callers.
    frame: (frame) => {
      const cached = frameBytes(frame);
      return { raw: cached.raw.slice(), binary: cached.binary.slice(), black: cached.black };
    },
    raw: (frame) => frameBytes(frame).raw.slice(),
    binary: (frame) => frameBytes(frame).binary.slice(),
    black: (frame) => frameBytes(frame).black,
    pixel: (frame, index) => frameBytes(frame).raw[index],
    frameStartPs,
    frameEndPs,
    pixelRisePs,
    pixelRiseAtPs,
    lastPixelRisePs,
    lastDmaPs,
    resultsIssueCycles,
    resultTimePs: (frame, dmaPs = timing.dmaPs) =>
      lastDmaPs(frame, dmaPs) + resultsIssueCycles * timing.cyclePs,
  });
}

const models = new Map();
const cameraModels = new Map();

function pins(d, camera) {
  d.pin({ name: 'supply' });
  d.pin({ name: 'reference' });
  for (const name of signals)
    d.pin({
      name,
      low: 0.8,
      high: 2.0,
      ...(camera ? { initial: (b) => b.returnValue(b.resistor('reference', 25)) } : {}),
    });
}
function drive(b, name, high) {
  b.if(
    high,
    (c) => c.writeIntent(name, c.resistor('supply', 25)),
    (c) => c.writeIntent(name, c.resistor('reference', 25)),
  );
}
function high(b, pin) {
  const sample = b.readSample(pin);
  b.assert(
    b.not(b.equal(types.logic, b.field(sample, 'level'), types.logic.members.unknown)),
    () => 'Camera parallel bus pin must be electrically resolved at the sampling edge',
  );
  return b.equal(types.logic, b.field(sample, 'level'), types.logic.members.high);
}

export function cameraModel() {
  if (cameraModels.has('default')) return cameraModels.get('default');
  const d = createDeviceBuilder();
  pins(d, true);
  for (const name of ['frame', 'row', 'column']) d.state({ name, type: types.number, initial: 0 });
  d.start((b) => {
    b.wait(timing.startPs);
    b.loop((c) => {
      const frame = c.readState('frame', types.number);
      drive(c, 'vsync', true);
      c.wait(timing.vsyncPs);
      drive(c, 'vsync', false);
      c.writeState('row', 0);
      c.while(
        (e) => e.lessThan(e.readState('row', types.number), timing.height),
        (e) => {
          const row = e.readState('row', types.number);
          drive(e, 'href', true);
          e.writeState('column', 0);
          e.while(
            (f) => f.lessThan(f.readState('column', types.number), timing.width),
            (f) => {
              const column = f.readState('column', types.number);
              const index = f.add(f.multiply(row, timing.width), column);
              const value = f.bitAnd(
                f.add(f.add(f.multiply(frame, 37), f.multiply(index, 29)), f.multiply(row, 17)),
                255,
              );
              for (let bit = 0; bit < 8; bit++)
                drive(f, `d${bit}`, f.notEqual(types.number, f.bitAnd(value, 1 << bit), 0));
              f.wait(timing.pixelPs / 2);
              drive(f, 'pclk', true);
              f.wait(timing.pixelPs / 2);
              drive(f, 'pclk', false);
              f.writeState('column', f.add(column, 1));
            },
          );
          drive(e, 'href', false);
          e.wait(timing.hblankPs);
          e.writeState('row', e.add(row, 1));
        },
      );
      c.writeState('frame', c.add(frame, 1));
      c.wait(timing.verticalBlankPs);
    });
  });
  const model = d.finish();
  cameraModels.set('default', model);
  return model;
}

function modelKey({ dmaDelayPs, tracePixels }) {
  return `${dmaDelayPs}:${tracePixels ? 1 : 0}`;
}

/**
 * Synthetic MCU with a DCMI-style parallel capture peripheral. The capture unit
 * samples the electrical pins in model processes on every PCLK edge, holds the
 * byte for `dmaDelayPs`, then writes it into the shared single-buffer `raw` RAM.
 * Frame completion latches one pending IRQ; the JIT firmware alone reads `raw`,
 * writes `binary`, and counts pixels below the threshold.
 */
export function mcuModel(options = {}) {
  const dmaDelayPs = options.dmaDelayPs ?? timing.dmaPs;
  const tracePixels = options.tracePixels ?? false;
  if (!Number.isSafeInteger(dmaDelayPs) || dmaDelayPs <= 0)
    throw new RangeError('dmaDelayPs must be a positive integer');
  const key = modelKey({ dmaDelayPs, tracePixels });
  if (models.has(key)) return models.get(key);
  const d = createDeviceBuilder();
  pins(d, false);
  d.memory({ name: 'code', length: 32 });
  d.memory({ name: 'raw', length: timing.pixels, public: true });
  d.memory({ name: 'binary', length: timing.pixels, public: true });
  d.memory({ name: 'snapshot', length: snapshotFields.length * 4, public: true });
  for (const name of [
    'dmaIndex',
    'dmaFrames',
    'framesStarted',
    'processingFrame',
    'index',
    'black',
    'processed',
    'pc',
  ])
    d.state({ name, type: types.number, initial: 0 });
  for (const name of ['pending', 'busy']) d.state({ name, type: types.bool, initial: false });
  for (const pin of ['pclk', 'vsync'])
    d.derived({ name: `${pin}High`, type: types.bool }, (b) => b.returnValue(high(b, pin)));
  d.on({ name: 'frameSync', sourcePath: ['vsyncHigh'] }, (b) => {
    b.if(b.readDerived('vsyncHigh', types.bool), (c) => {
      c.assert(
        c.or(c.equal(types.number, c.readState('framesStarted', types.number), 0), (e) =>
          e.equal(types.number, e.readState('dmaIndex', types.number), timing.pixels),
        ),
        () => 'Every previous camera frame must deliver all pixels before the next VSYNC',
      );
      c.assert(c.not(c.readState('busy', types.bool)), () => 'Frame overlaps firmware processing');
      c.assert(c.not(c.readState('pending', types.bool)), () => 'Unserviced frame IRQ at VSYNC');
      c.writeState('framesStarted', c.add(c.readState('framesStarted', types.number), 1));
      c.writeState('dmaIndex', 0);
    });
  });
  d.on({ name: 'dma', sourcePath: ['pclkHigh'] }, (b) => {
    b.if(b.readDerived('pclkHigh', types.bool), (c) => {
      c.if(high(c, 'href'), (e) => {
        e.assert(e.not(high(e, 'vsync')), () => 'Capture while VSYNC is active');
        const value = e.local(types.number, 0);
        for (let bit = 0; bit < 8; bit++)
          e.if(high(e, `d${bit}`), (f) => f.setLocal(value, f.bitOr(f.getLocal(value), 1 << bit)));
        const index = e.readState('dmaIndex', types.number);
        e.assert(e.lessThan(index, timing.pixels), () => 'DMA index exceeded one camera frame');
        e.if(e.equal(types.number, index, 0), (f) =>
          f.assert(
            f.not(f.readState('busy', types.bool)),
            () => 'Single-buffer DMA starts while firmware still reads the previous frame',
          ),
        );
        e.wait(dmaDelayPs);
        const stored = e.getLocal(value);
        e.store8('raw', index, stored);
        e.writeState('dmaIndex', e.add(index, 1));
        if (tracePixels) e.send('pixelTrace', e.add(e.multiply(index, 256), stored));
        e.if(e.equal(types.number, e.add(index, 1), timing.pixels), (f) => {
          f.assert(
            f.not(f.readState('busy', types.bool)),
            () => 'DMA overlaps firmware processing',
          );
          f.assert(f.not(f.readState('pending', types.bool)), () => 'Duplicate frame IRQ');
          f.writeState('dmaFrames', f.add(f.readState('dmaFrames', types.number), 1));
          f.writeState('pending', true);
          f.send('frameDone', f.readState('dmaFrames', types.number));
        });
      });
    });
  });
  d.derived({ name: 'takeIrq', type: types.bool }, (b) =>
    b.returnValue(
      b.and(b.readState('pending', types.bool), (c) => c.not(c.readState('busy', types.bool))),
    ),
  );
  d.pureFn({ name: 'hasFrame', params: [], returns: types.bool }, (b) =>
    b.returnValue(b.readState('pending', types.bool)),
  );
  d.fn({ name: 'enterIrq', params: [] }, (b) => {
    b.writeState('busy', true);
    b.writeState('pending', false);
    b.redirect(16, timing.irqEntryCycles * timing.cyclePs);
  });
  d.channel({ name: 'results', direction: 'output', type: types.number, capacity: 256 });
  d.channel({ name: 'frameDone', direction: 'output', type: types.number, capacity: 256 });
  if (tracePixels)
    d.channel({
      name: 'pixelTrace',
      direction: 'output',
      type: types.number,
      capacity: 4096,
      overflow: types.overflow.members.error,
    });
  d.notification({ name: 'snapshotRequest', direction: 'input' });
  d.on({ name: 'captureSnapshot', sourcePath: ['snapshotRequest'] }, (b) => {
    snapshotFields.forEach((name, i) => {
      if (name === 'pending' || name === 'busy')
        b.store32le(
          'snapshot',
          i * 4,
          b.select(
            types.number,
            b.readState(name, types.bool),
            () => 1,
            () => 0,
          ),
        );
      else b.store32le('snapshot', i * 4, b.readState(name, types.number));
    });
  });
  const model = d.finish();
  models.set(key, model);
  return model;
}

// Synthetic fixed-cost pixel ISA, not ARM/Cortex-M: PC 16 setup 1 cycle, PC 17
// (load, compare, byte store, conditional count, increment, branch) 6 cycles,
// publish 2, ISR exit 12, IRQ entry 12. One pixel per instruction.
export function translator(options = {}) {
  const pixelCycles = options.pixelCycles ?? timing.pixelCycles;
  if (!Number.isSafeInteger(pixelCycles) || pixelCycles <= 0)
    throw new RangeError('pixelCycles must be a positive integer');
  return ({ pc, code }, block) => {
    if (code[pc] !== pc) throw new Error(`Invalid camera firmware PC ${pc}`);
    block.instruction({ pc, nextPc: pc }, (b) => {
      const state = (name) => b.readState(name, types.number);
      if (pc === 0) {
        b.elapse(timing.cyclePs);
        b.waitUntil('hasFrame');
      } else if (pc === 16) {
        b.writeState('processingFrame', state('dmaFrames'));
        b.writeState('black', 0);
        b.writeState('index', 0);
        b.redirect(17, timing.frameSetupCycles * timing.cyclePs);
      } else if (pc === 17) {
        const index = state('index');
        const black = b.lessThan(b.load8('raw', index), timing.threshold);
        b.store8(
          'binary',
          index,
          b.select(
            types.number,
            black,
            () => 0,
            () => 1,
          ),
        );
        b.if(black, (c) => c.writeState('black', c.add(c.readState('black', types.number), 1)));
        b.writeState('index', b.add(index, 1));
        b.redirect(
          b.select(
            types.number,
            b.lessThan(b.add(index, 1), timing.pixels),
            () => 17,
            () => 18,
          ),
          pixelCycles * timing.cyclePs,
        );
      } else if (pc === 18) {
        b.send('results', state('black'));
        b.writeState('processed', b.add(state('processed'), 1));
        b.redirect(19, timing.publishCycles * timing.cyclePs);
      } else if (pc === 19) {
        b.writeState('busy', false);
        b.redirect(0, timing.isrExitCycles * timing.cyclePs);
      } else throw new Error(`Unknown camera firmware PC ${pc}`);
    });
    return block.finish();
  };
}
