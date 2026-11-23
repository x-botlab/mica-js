// PROTOTYPE: 灰度摄像头 + DCMI/DMA 模型（基准专用）。
import { createDeviceBuilder, types } from '../../../device-model/dist/index.js';

// 160x120 8-bit parallel gray camera, 30 fps, 1 MHz PCLK, and a synthetic
// nominal-100 MHz MCU with a DCMI-style capture unit and DMA. Integer picoseconds.
//
// Frame structure (one full period including all blanking):
//   VSYNC high 1 ms, `height` lines of `width * 1 us + 40 us`, vertical blanking.
// Each line: HREF high for the active window, data setup in the first half of the
// pixel, PCLK rising edge in the middle, PCLK falling edge at the pixel boundary.
// The capture unit samples the byte on the PCLK falling edge and writes `raw`
// synchronously (zero DMA latency) so the frame completes on the last pixel fall.
export function makeTiming(width = 160, height = 120) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0)
    throw new RangeError('Camera geometry must be positive integers');
  const pixelPs = 1_000_000;
  const hblankPs = 40_000_000;
  const linePeriodPs = width * pixelPs + hblankPs;
  const activePs = width * pixelPs;
  const framePeriodPs = 33_333_333_333;
  const startPs = 1_000_000_000;
  const vsyncPs = 1_000_000_000;
  const verticalBlankPs = framePeriodPs - vsyncPs - height * linePeriodPs;
  if (verticalBlankPs < 0) throw new RangeError('Camera geometry exceeds the frame period');
  const timing = Object.freeze({
    width,
    height,
    pixels: width * height,
    threshold: 100,
    mcuHz: 100_000_000,
    cyclePs: 10_000,
    pclkHz: 1_000_000,
    pixelPs,
    activePs,
    hblankPs,
    linePeriodPs,
    frameRateHz: 30,
    framePeriodPs,
    startPs,
    vsyncPs,
    verticalBlankPs,
    // HREF drops one picosecond after the last falling edge so the capture unit
    // still samples HREF high on the final pixel.
    hrefDropPs: 1,
    irqEntryCycles: 12,
    isrExitCycles: 12,
    frameSetupCycles: 1,
    histogramClearCycles: 2,
    pixelCycles: 10,
    checksumCycles: 6,
    publishCycles: 2,
  });
  if (timing.linePeriodPs !== timing.activePs + timing.hblankPs)
    throw new Error('Camera line timing must add up');
  return timing;
}

export const defaultTiming = makeTiming();

export const nominalFrameRateHz = (timing) => 1e12 / timing.framePeriodPs;
export const frameStartPs = (timing, frame) => timing.startPs + frame * timing.framePeriodPs;
export const frameEndPs = (timing, frame) => frameStartPs(timing, frame + 1);
export const lineStartPs = (timing, frame, row) =>
  frameStartPs(timing, frame) + timing.vsyncPs + row * timing.linePeriodPs;
export const pixelFallPs = (timing, frame, row, column) =>
  lineStartPs(timing, frame, row) + (column + 1) * timing.pixelPs;
export const pixelFallAtPs = (timing, frame, index) =>
  pixelFallPs(timing, frame, Math.floor(index / timing.width), index % timing.width);
export const lastPixelFallPs = (timing, frame) =>
  lineStartPs(timing, frame, timing.height - 1) + timing.activePs;
// Entry (12) + PC16 setup (1) + 256 histogram clears (2 each) + one instruction per
// pixel (10) + PC18 setup (1) + 256 checksum steps (6 each) reach results.send before
// the two-cycle publish tail.
export const resultsIssueCycles = (timing) =>
  timing.irqEntryCycles +
  timing.frameSetupCycles +
  256 * timing.histogramClearCycles +
  timing.pixels * timing.pixelCycles +
  timing.frameSetupCycles +
  256 * timing.checksumCycles;

export const snapshotFields = Object.freeze([
  'dmaIndex',
  'dmaFrames',
  'framesStarted',
  'processingFrame',
  'index',
  'black',
  'processed',
  'pc',
  'checksum',
  'pending',
  'busy',
]);
export const signals = Object.freeze([
  'vsync',
  'href',
  'pclk',
  ...Array.from({ length: 8 }, (_, bit) => `d${bit}`),
]);

/**
 * Independent camera/capture oracle. It never runs inside the board and uses a
 * different pixel decomposition than the camera model:
 *   model:  (frame*37 + (row*width+column)*29 + row*17) & 255
 *   oracle: (frame*37 + row*rowStride + column*29) & 255
 * with rowStride = (29*width + 17) mod 256, which makes the two equivalent.
 */
export function createGrayCameraOracle(timing = defaultTiming) {
  const rowStride = (29 * timing.width + 17) & 255;
  const frameCache = new Map();
  const frameBytes = (frame) => {
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new RangeError('Oracle frame must be a non-negative integer');
    let cached = frameCache.get(frame);
    if (cached) return cached;
    const raw = new Uint8Array(timing.pixels);
    const binary = new Uint8Array(timing.pixels);
    const histogram = new Uint32Array(256);
    let black = 0;
    let checksum = 0;
    for (let row = 0; row < timing.height; row++) {
      for (let column = 0; column < timing.width; column++) {
        const index = row * timing.width + column;
        const value = (frame * 37 + row * rowStride + column * 29) & 255;
        raw[index] = value;
        histogram[value]++;
        if (value < timing.threshold) {
          binary[index] = 0;
          black++;
        } else binary[index] = 1;
      }
    }
    for (let bin = 0; bin < 256; bin++)
      checksum = (checksum + histogram[bin] * (bin + 1)) % 1_000_003;
    cached = Object.freeze({ raw, binary, histogram, black, checksum });
    frameCache.set(frame, cached);
    return cached;
  };
  return Object.freeze({
    threshold: timing.threshold,
    // Copies keep the cached pattern immutable for callers.
    frame: (frame) => {
      const cached = frameBytes(frame);
      return {
        raw: cached.raw.slice(),
        binary: cached.binary.slice(),
        histogram: Uint32Array.from(cached.histogram),
        black: cached.black,
        checksum: cached.checksum,
      };
    },
    raw: (frame) => frameBytes(frame).raw.slice(),
    binary: (frame) => frameBytes(frame).binary.slice(),
    histogram: (frame) => Uint32Array.from(frameBytes(frame).histogram),
    black: (frame) => frameBytes(frame).black,
    checksum: (frame) => frameBytes(frame).checksum,
    pixel: (frame, index) => frameBytes(frame).raw[index],
    frameStartPs: (frame) => frameStartPs(timing, frame),
    frameEndPs: (frame) => frameEndPs(timing, frame),
    pixelFallAtPs: (frame, index) => pixelFallAtPs(timing, frame, index),
    lastPixelFallPs: (frame) => lastPixelFallPs(timing, frame),
    resultsIssueCycles: resultsIssueCycles(timing),
    resultTimePs: (frame) =>
      lastPixelFallPs(timing, frame) + resultsIssueCycles(timing) * timing.cyclePs,
  });
}

const cameraModels = new Map();
const mcuModels = new Map();

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
    () => 'Camera parallel bus pin must be electrically resolved at the sampling edge',
  );
  return b.equal(types.logic, b.field(sample, 'level'), types.logic.members[member]);
}
const high = (b, pin) => levelIs(b, pin, 'high');

/**
 * The camera keeps the full electrical per-pixel path. With `bus` enabled the
 * per-pixel body is replaced by one wait per active line: the host drives the
 * transport burst over that window and the electrical pins only receive the
 * final levels. Both paths keep the identical pixel/line timing.
 */
export function cameraModel(timing = defaultTiming, bus = false) {
  const key = `${timing.width}x${timing.height}:${bus ? 1 : 0}`;
  if (cameraModels.has(key)) return cameraModels.get(key);
  const d = createDeviceBuilder();
  d.property({ name: 'bus', type: types.bool, default: false });
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
          e.if(
            e.readProperty('bus', types.bool),
            (f) => f.wait(timing.activePs + timing.hrefDropPs),
            (f) => {
              f.writeState('column', 0);
              f.while(
                (g) => g.lessThan(g.readState('column', types.number), timing.width),
                (g) => {
                  const column = g.readState('column', types.number);
                  const index = g.add(g.multiply(row, timing.width), column);
                  const value = g.bitAnd(
                    g.add(g.add(g.multiply(frame, 37), g.multiply(index, 29)), g.multiply(row, 17)),
                    255,
                  );
                  for (let bit = 0; bit < 8; bit++)
                    drive(g, `d${bit}`, g.notEqual(types.number, g.bitAnd(value, 1 << bit), 0));
                  g.wait(timing.pixelPs / 2);
                  drive(g, 'pclk', true);
                  g.wait(timing.pixelPs / 2);
                  drive(g, 'pclk', false);
                  // Zero-duration suspension: publish the falling edge with the pixel's own
                  // data still on the bus before the next pixel's setup overwrites it.
                  g.wait(0);
                  g.writeState('column', g.add(column, 1));
                },
              );
              // The capture unit samples HREF high on the final falling edge.
              f.wait(timing.hrefDropPs);
            },
          );
          drive(e, 'href', false);
          e.wait(timing.hblankPs - timing.hrefDropPs);
          e.writeState('row', e.add(row, 1));
        },
      );
      c.writeState('frame', c.add(frame, 1));
      c.wait(timing.verticalBlankPs);
    });
  });
  const model = d.finish();
  cameraModels.set(key, model);
  return model;
}

/**
 * Synthetic MCU with a DCMI-style parallel capture peripheral. The capture unit
 * samples the electrical pins on every PCLK falling edge and writes the byte into
 * the shared single-buffer `raw` RAM synchronously. Frame completion latches one
 * pending IRQ; the JIT firmware alone reads `raw`, writes `binary`, maintains a
 * 256-bin histogram and counts pixels below the threshold.
 */
export function mcuModel(timing = defaultTiming) {
  const key = `${timing.width}x${timing.height}`;
  if (mcuModels.has(key)) return mcuModels.get(key);
  const d = createDeviceBuilder();
  pins(d, false);
  d.memory({ name: 'code', length: 32 });
  d.memory({ name: 'raw', length: timing.pixels, public: true });
  d.memory({ name: 'binary', length: timing.pixels, public: true });
  d.memory({ name: 'hist', length: 256 * 4, public: true });
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
    'checksum',
    'histIndex',
  ])
    d.state({ name, type: types.number, initial: 0 });
  for (const name of ['pending', 'busy']) d.state({ name, type: types.bool, initial: false });
  d.derived({ name: 'pclkHigh', type: types.bool }, (b) => b.returnValue(high(b, 'pclk')));
  d.derived({ name: 'pclkLow', type: types.bool }, (b) => b.returnValue(levelIs(b, 'pclk', 'low')));
  d.derived({ name: 'vsyncHigh', type: types.bool }, (b) => b.returnValue(high(b, 'vsync')));
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
  d.on({ name: 'dma', sourcePath: ['pclkLow'] }, (b) => {
    b.if(b.readDerived('pclkLow', types.bool), (c) => {
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
        e.store8('raw', index, e.getLocal(value));
        e.writeState('dmaIndex', e.add(index, 1));
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
  d.notification({ name: 'snapshotRequest', direction: 'input' });
  d.on({ name: 'captureSnapshot', sourcePath: ['snapshotRequest'] }, (b) => {
    snapshotFields.forEach((name, index) => {
      if (name === 'pending' || name === 'busy')
        b.store32le(
          'snapshot',
          index * 4,
          b.select(
            types.number,
            b.readState(name, types.bool),
            () => 1,
            () => 0,
          ),
        );
      else b.store32le('snapshot', index * 4, b.readState(name, types.number));
    });
  });
  const model = d.finish();
  mcuModels.set(key, model);
  return model;
}

// Synthetic fixed-cost pixel ISA, not ARM/Cortex-M: PC 16 clears the histogram and
// start counters (256 bins * 2 cycles), PC 17 is one pixel (load, threshold, store,
// 32-bit histogram increment, conditional count, increment, branch; 10 cycles),
// PC 18..19 compute the histogram checksum, PC 20 publishes both results, PC 21
// leaves the ISR.
export function translator(timing = defaultTiming) {
  return ({ pc, code }, block) => {
    if (code[pc] !== pc) throw new Error(`Invalid gray-camera firmware PC ${pc}`);
    block.instruction({ pc, nextPc: pc }, (b) => {
      const state = (name) => b.readState(name, types.number);
      if (pc === 0) {
        b.elapse(timing.cyclePs);
        b.waitUntil('hasFrame');
      } else if (pc === 16) {
        b.writeState('processingFrame', state('dmaFrames'));
        b.writeState('black', 0);
        b.writeState('index', 0);
        b.writeState('histIndex', 0);
        b.writeState('checksum', 0);
        b.redirect(22, timing.frameSetupCycles * timing.cyclePs);
      } else if (pc === 22) {
        const index = state('histIndex');
        b.store32le('hist', b.multiply(index, 4), 0);
        b.writeState('histIndex', b.add(index, 1));
        b.redirect(
          b.select(
            types.number,
            b.lessThan(b.add(index, 1), 256),
            () => 22,
            () => 17,
          ),
          timing.histogramClearCycles * timing.cyclePs,
        );
      } else if (pc === 17) {
        const index = state('index');
        const value = b.load8('raw', index);
        const black = b.lessThan(value, timing.threshold);
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
        const bin = b.multiply(value, 4);
        b.store32le('hist', bin, b.add(b.load32le('hist', bin), 1));
        b.if(black, (c) => c.writeState('black', c.add(c.readState('black', types.number), 1)));
        b.writeState('index', b.add(index, 1));
        b.redirect(
          b.select(
            types.number,
            b.lessThan(b.add(index, 1), timing.pixels),
            () => 17,
            () => 18,
          ),
          timing.pixelCycles * timing.cyclePs,
        );
      } else if (pc === 18) {
        b.writeState('histIndex', 0);
        b.writeState('checksum', 0);
        b.redirect(19, timing.frameSetupCycles * timing.cyclePs);
      } else if (pc === 19) {
        const index = state('histIndex');
        const count = b.load32le('hist', b.multiply(index, 4));
        b.writeState(
          'checksum',
          b.remainder(b.add(state('checksum'), b.multiply(count, b.add(index, 1))), 1_000_003),
        );
        b.writeState('histIndex', b.add(index, 1));
        b.redirect(
          b.select(
            types.number,
            b.lessThan(b.add(index, 1), 256),
            () => 19,
            () => 20,
          ),
          timing.checksumCycles * timing.cyclePs,
        );
      } else if (pc === 20) {
        b.send('results', state('black'));
        b.send('results', state('checksum'));
        b.writeState('processed', b.add(state('processed'), 1));
        b.redirect(21, timing.publishCycles * timing.cyclePs);
      } else if (pc === 21) {
        b.writeState('busy', false);
        b.redirect(0, timing.isrExitCycles * timing.cyclePs);
      } else throw new Error(`Unknown gray-camera firmware PC ${pc}`);
    });
    return block.finish();
  };
}
