// PROTOTYPE: 灰度摄像头基准（Level A 传输级旁路验证）。只新建文件，不改动既有基准。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeviceBuilder } from '../../device-model/dist/index.js';
import {
  cameraModel,
  createGrayCameraOracle,
  frameEndPs,
  frameStartPs,
  lineStartPs,
  makeTiming,
  mcuModel,
  nominalFrameRateHz,
  resultsIssueCycles,
  signals,
  snapshotFields,
  translator,
} from './workloads/gray-camera.mjs';

export {
  cameraModel,
  createGrayCameraOracle,
  defaultTiming as timing,
  frameEndPs,
  frameStartPs,
  lineStartPs,
  makeTiming,
  nominalFrameRateHz,
  resultsIssueCycles,
} from './workloads/gray-camera.mjs';

export const limits = Object.freeze({
  frames: 36,
  samples: 30,
  warmupFrames: 5,
});
export const defaults = Object.freeze({
  execution: 'throughput',
  samples: 3,
  warmupFrames: 1,
  bus: false,
});

const quantumPs = 10_000_000;
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
};

export function normalizeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Options must be an object');
  for (const key of Object.keys(options))
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`Unknown option: ${key}`);
  const config = { ...defaults, ...options };
  if (!['throughput', 'precise'].includes(config.execution))
    throw new RangeError('execution must be throughput or precise');
  if (typeof config.bus !== 'boolean') throw new TypeError('bus must be a boolean');
  integer(config.samples, 1, limits.samples, 'samples');
  integer(config.warmupFrames, 0, limits.warmupFrames, 'warmupFrames');
  if (config.samples + config.warmupFrames + 1 > limits.frames)
    throw new RangeError('The frame budget is exceeded');
  return Object.freeze(config);
}

export function parseArgs(args) {
  const config = { ...defaults };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!['--samples', '--warmup-frames', '--execution', '--bus'].includes(argument))
      throw new RangeError(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new RangeError(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === '--bus') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) config.bus = true;
      else {
        index++;
        if (next !== 'true' && next !== 'false')
          throw new RangeError('--bus must be true or false');
        config.bus = next === 'true';
      }
      continue;
    }
    const value = args[++index];
    if (value === undefined) throw new RangeError(`Missing argument: ${argument}`);
    if (argument === '--execution') config.execution = value;
    else if (argument === '--samples') config.samples = Number(value);
    else config.warmupFrames = Number(value);
  }
  return normalizeOptions(config);
}

const digest = (bytes) => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');

/** Test-only third device: one passive pin on a named bus net. */
function monitorModel(net) {
  const d = createDeviceBuilder();
  d.pin({ name: 'supply' });
  d.pin({ name: 'reference' });
  d.pin({
    name: net,
    low: 0.8,
    high: 2.0,
    initial: (b) => b.returnValue(b.resistor('reference', 25)),
  });
  return d.finish();
}

const busConfig = Object.freeze({
  pclkEdge: 'fall',
  width: 8,
  bitOrder: 'lsb-first',
  clockKey: 'pclk',
  dataKey: 'data',
  clockIdle: 'low',
  highPin: 'supply',
  lowPin: 'reference',
  resistance: 25,
});
const busPins = Object.freeze({
  vsync: 'vsync',
  href: 'href',
  pclk: 'pclk',
  data: Object.freeze(Array.from({ length: 8 }, (_, bit) => `d${bit}`)),
});

/**
 * One 160x120 8-bit parallel camera and one synthetic nominal-100 MHz MCU with a
 * DCMI-style capture unit and DMA. The camera drives a fully electrical 11-wire
 * parallel bus; capture and the raw RAM write are model processes. The JIT firmware
 * alone thresholds raw pixels into binary, maintains a 256-bin histogram and counts
 * pixels below the threshold. Only runUntil and, with `bus`, the transport burst are
 * timed. create() is cold.
 *
 * `internals.width/height` exists for tests only and shrinks the geometry without
 * changing the model or the verification. `internals.monitorNet` attaches one extra
 * passive device to a named bus net so the node-exclusivity guard can be exercised.
 */
export function create(sdk, options = {}, internals = {}) {
  const config = normalizeOptions(options);
  if (typeof sdk?.createBoard !== 'function' || typeof sdk?.createDeviceLibrary !== 'function')
    throw new TypeError('Supply the public simulator SDK module');
  for (const key of Object.keys(internals))
    if (!['width', 'height', 'monitorNet'].includes(key))
      throw new TypeError(`Unknown internal option: ${key}`);
  const geometry = { width: internals.width ?? 160, height: internals.height ?? 120 };
  const monitorNet = internals.monitorNet;
  if (monitorNet !== undefined && !signals.includes(monitorNet))
    throw new RangeError('monitorNet must be one of the camera signals');
  const timing = makeTiming(geometry.width, geometry.height);
  const oracle = createGrayCameraOracle(timing);
  const results = [];
  const frameDone = [];
  const frameTrace = [];
  let mcu;
  let cameraBus;
  const entries = [
    {
      id: 'camera',
      model: cameraModel(timing, config.bus),
      create(ctx) {
        cameraBus = ctx.attachBus({
          profile: 'parallel-sync',
          role: 'initiator',
          resolve: () => ({ pins: busPins, config: busConfig }),
        });
        return {
          sync() {},
          dispose() {},
        };
      },
    },
    {
      id: 'mcu',
      model: mcuModel(timing),
      create(ctx) {
        const binding = {
          pins: busPins,
          config: busConfig,
          onSlice(slice) {
            if (dmaIndex === timing.pixels) dmaIndex = 0;
            effects.writeMemory('raw', dmaIndex, slice.tx);
            dmaIndex += slice.count;
            effects.writeState('dmaIndex', dmaIndex);
            if (dmaIndex === timing.pixels) {
              dmaFrames += 1;
              effects.writeState('dmaFrames', dmaFrames);
              effects.writeState('pending', true);
              effects.emit('frameDone', dmaFrames);
              frameTrace.push({ frame: dmaFrames - 1, timePs: slice.endTimePs });
            }
          },
        };
        const endpoint = ctx.attachBus({
          profile: 'parallel-sync',
          role: 'target',
          resolve: () => (config.bus ? binding : undefined),
        });
        const effects = endpoint.effects;
        let dmaIndex = 0;
        let dmaFrames = 0;
        mcu = ctx;
        const jit = ctx.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          beforeInstruction: { when: 'takeIrq', call: 'enterIrq' },
          translate: translator(timing),
        });
        ctx.loadBytes(
          'code',
          Uint8Array.from({ length: 32 }, (_, index) => index),
        );
        return {
          sync(batch) {
            results.push(...batch.outputs.results);
            frameDone.push(...batch.outputs.frameDone);
          },
          dispose() {
            jit.dispose();
          },
        };
      },
    },
  ];
  if (monitorNet !== undefined) {
    entries.push({
      id: 'monitor',
      model: monitorModel(monitorNet),
      create() {
        return { sync() {}, dispose() {} };
      },
    });
  }
  const library = sdk.createDeviceLibrary(entries);
  const endpoint = (instance, pin) => ({ instance, pin });
  const instances = [
    { id: 'camera', type: 'camera', props: { bus: config.bus } },
    { id: 'mcu', type: 'mcu' },
  ];
  if (monitorNet !== undefined) instances.push({ id: 'monitor', type: 'monitor' });
  const nets = [
    ...[
      ['supply', 3.3],
      ['reference', 0],
    ].map(([id, voltage]) => ({
      id,
      voltage,
      pins: [endpoint('camera', id), endpoint('mcu', id)],
    })),
    ...signals.map((id) => ({
      id,
      pins:
        id === monitorNet
          ? [endpoint('camera', id), endpoint('mcu', id), endpoint('monitor', id)]
          : [endpoint('camera', id), endpoint('mcu', id)],
    })),
  ];
  const board = sdk.createBoard(
    library,
    { instances, nets },
    {
      execution: config.execution,
      cpuQuantum: quantumPs,
    },
  );
  assert.equal(board.time, 0, 'create() must not advance the board');
  const framesCompletedAt = (time) =>
    Math.max(0, Math.floor((time - timing.startPs) / timing.framePeriodPs));
  let completedFrames = 0;
  let disposed = false;
  let totalWallSeconds = 0;
  let totalRunUntilCalls = 0;
  let totalTransferCalls = 0;
  const valid = () => {
    if (disposed) throw new Error('Gray camera benchmark is disposed');
  };
  const memory = () => {
    valid();
    return {
      raw: Uint8Array.from(mcu.memory.raw),
      binary: Uint8Array.from(mcu.memory.binary),
      hist: Uint8Array.from(mcu.memory.hist),
    };
  };
  /** Oracle bytes are regenerated once per frame, never per line burst. */
  let frameBytes = { frame: -1, raw: undefined };
  const rawFor = (frame) => {
    if (frameBytes.frame !== frame) frameBytes = { frame, raw: oracle.raw(frame) };
    return frameBytes.raw;
  };
  const runTimed = (target) => {
    const start = performance.now();
    board.runUntil(target);
    return (performance.now() - start) / 1_000;
  };
  /** One bounded transport burst, timed like a runUntil call. */
  function transferLine(frame, row) {
    valid();
    const lineStart = frameStartPs(timing, frame) + timing.vsyncPs + row * timing.linePeriodPs;
    assert.equal(board.time, lineStart, 'A line burst starts exactly at its line start');
    const raw = rawFor(frame);
    const tx = raw.subarray(row * timing.width, (row + 1) * timing.width);
    const start = performance.now();
    const accepted = cameraBus.transfer({
      totalUnits: timing.width,
      unitDurationPs: timing.pixelPs,
      tx,
    });
    const wallSeconds = (performance.now() - start) / 1_000;
    totalTransferCalls++;
    totalWallSeconds += wallSeconds;
    return { accepted, wallSeconds };
  }
  function stepTo(target) {
    valid();
    integer(target, 0, frameEndPs(timing, limits.frames - 1), 'target ps');
    if (target < board.time) throw new RangeError('Cannot run backwards');
    const from = board.time;
    let wallSeconds = 0;
    let runUntilCalls = 0;
    while (board.time < target) {
      wallSeconds += runTimed(target);
      runUntilCalls++;
    }
    totalWallSeconds += wallSeconds;
    totalRunUntilCalls += runUntilCalls;
    completedFrames = framesCompletedAt(board.time);
    const simulatedSeconds = (board.time - from) / 1e12;
    return {
      from,
      to: board.time,
      simulatedSeconds,
      wallSeconds,
      realTimeFactor: simulatedSeconds / wallSeconds,
      runUntilCalls,
    };
  }
  function stepFrame() {
    valid();
    assert(completedFrames < limits.frames, 'The frame budget is exceeded');
    const frame = completedFrames;
    const from = board.time;
    let wallSeconds = 0;
    let runUntilCalls = 0;
    if (config.bus) {
      for (let row = 0; row < timing.height; row++) {
        const lineStart = lineStartPs(timing, frame, row);
        wallSeconds += runTimed(lineStart);
        runUntilCalls++;
        const burst = transferLine(frame, row);
        wallSeconds += burst.wallSeconds;
        assert(burst.accepted, 'The transport burst must be accepted in bus mode');
      }
    }
    wallSeconds += runTimed(frameEndPs(timing, frame));
    runUntilCalls++;
    totalWallSeconds += wallSeconds;
    totalRunUntilCalls += runUntilCalls;
    completedFrames = framesCompletedAt(board.time);
    assert.equal(completedFrames, frame + 1, 'A frame step must complete exactly one frame');
    const simulatedSeconds = (board.time - from) / 1e12;
    return {
      from,
      to: board.time,
      simulatedSeconds,
      wallSeconds,
      realTimeFactor: simulatedSeconds / wallSeconds,
      runUntilCalls,
      transferCalls: config.bus ? timing.height : 0,
      frame,
      frames: 1,
    };
  }

  function verifyFrame(frame = completedFrames - 1, { digestBytes = false } = {}) {
    valid();
    assert.equal(board.status, 'ready');
    assert(Number.isSafeInteger(frame) && frame >= 0 && frame < completedFrames);
    assert.equal(frame, completedFrames - 1, 'Only the most recent camera frame remains in RAM');
    assert.equal(results.length, completedFrames * 2, 'Two firmware results per frame');
    const expected = oracle.frame(frame);
    const raw = mcu.memory.raw;
    const binary = mcu.memory.binary;
    const histogram = Uint8Array.from(mcu.memory.hist);
    const view = new DataView(histogram.buffer, histogram.byteOffset, histogram.byteLength);
    let rawMismatches = 0;
    let binaryMismatches = 0;
    let histogramMismatches = 0;
    for (let index = 0; index < timing.pixels; index++) {
      if (raw[index] !== expected.raw[index]) rawMismatches++;
      if (binary[index] !== expected.binary[index]) binaryMismatches++;
    }
    for (let bin = 0; bin < 256; bin++)
      if (view.getUint32(bin * 4, true) !== expected.histogram[bin]) histogramMismatches++;
    assert.equal(rawMismatches, 0, 'Raw DMA RAM differs from the independent camera oracle');
    assert.equal(binaryMismatches, 0, 'Binary RAM differs from the independent threshold oracle');
    assert.equal(histogramMismatches, 0, 'Histogram differs from the independent oracle');
    const black = results[frame * 2];
    const checksum = results[frame * 2 + 1];
    assert.equal(black.value, expected.black, 'Black pixel count');
    assert.equal(checksum.value, expected.checksum, 'Histogram checksum');
    const completion = config.bus ? frameTrace[frame]?.timePs : frameDone[frame]?.time;
    assert.equal(
      completion,
      oracle.lastPixelFallPs(frame),
      'Frame completes on the last pixel fall',
    );
    assert.equal(black.time, oracle.resultTimePs(frame), 'Firmware result publication time');
    assert.equal(checksum.time, black.time, 'Both results publish in the same instruction');
    return {
      frame,
      pixels: timing.pixels,
      black: black.value,
      checksum: checksum.value,
      rawMismatches,
      binaryMismatches,
      histogramMismatches,
      ...(digestBytes ? { rawDigest: digest(raw), binaryDigest: digest(binary) } : {}),
      frameDoneTimePs: completion,
      lastPixelFallPs: oracle.lastPixelFallPs(frame),
      resultTimePs: black.time,
      processingLatencyPs: black.time - completion,
      expectedProcessingLatencyPs: resultsIssueCycles(timing) * timing.cyclePs,
    };
  }

  function captureState() {
    valid();
    mcu.inputs.snapshotRequest.notify();
    const captureStart = performance.now();
    board.runUntil(board.time);
    const wallSeconds = (performance.now() - captureStart) / 1_000;
    const bytes = Uint8Array.from(mcu.memory.snapshot);
    const view = new DataView(bytes.buffer);
    const state = Object.fromEntries(
      snapshotFields.map((name, index) => [name, view.getUint32(index * 4, true)]),
    );
    return { state, wallSeconds };
  }

  function verify() {
    valid();
    assert.equal(board.status, 'ready');
    assert(completedFrames > 0, 'Nothing has been simulated');
    assert.equal(
      board.time,
      frameEndPs(timing, completedFrames - 1),
      'Frames advance one period each',
    );
    const last = completedFrames - 1;
    const lastFrame = verifyFrame(last, { digestBytes: true });
    const blackCounts = [];
    const checksums = [];
    const completionTimes = [];
    const resultTimes = [];
    for (let frame = 0; frame < completedFrames; frame++) {
      const expected = oracle.frame(frame);
      assert.equal(results[frame * 2].value, expected.black, 'Complete per-frame black counts');
      assert.equal(results[frame * 2 + 1].value, expected.checksum, 'Complete checksums');
      assert.equal(results[frame * 2].time, oracle.resultTimePs(frame), 'Complete result times');
      const completion = config.bus ? frameTrace[frame]?.timePs : frameDone[frame]?.time;
      assert.equal(completion, oracle.lastPixelFallPs(frame), 'Complete frame completion times');
      blackCounts.push(expected.black);
      checksums.push(expected.checksum);
      completionTimes.push(completion);
      resultTimes.push(results[frame * 2].time);
    }
    const captured = captureState();
    const { state } = captured;
    assert.equal(state.dmaFrames, completedFrames, 'DMA completed every camera frame');
    assert.equal(state.framesStarted, completedFrames + 1, 'Capture unit saw the next VSYNC');
    assert.equal(state.processed, completedFrames, 'Firmware processed every frame');
    assert.equal(state.processingFrame, completedFrames, 'Firmware saw each frame ordinal');
    assert.equal(state.index, timing.pixels, 'Firmware scanned every pixel');
    assert.equal(state.black, oracle.black(last), 'Final black pixel count');
    assert.equal(state.checksum, oracle.checksum(last), 'Final histogram checksum');
    assert.equal(state.pc, 0, 'Firmware is waiting for the next frame');
    assert.equal(state.pending, 0, 'No unserviced frame IRQ');
    assert.equal(state.busy, 0, 'Firmware is not processing');
    assert.equal(state.dmaIndex, 0, 'Capture unit is re-armed for the next frame');
    const latencies = results
      .filter((_, index) => index % 2 === 0)
      .map((message, frame) => message.time - completionTimes[frame]);
    return {
      frames: completedFrames,
      lastFrame,
      lastFrameRawMismatches: lastFrame.rawMismatches,
      lastFrameBinaryMismatches: lastFrame.binaryMismatches,
      lastFrameHistogramMismatches: lastFrame.histogramMismatches,
      lastFrameRawDigest: lastFrame.rawDigest,
      lastFrameBinaryDigest: lastFrame.binaryDigest,
      frameCompletionTimesPs: completionTimes,
      resultTimesPs: resultTimes,
      blackCounts,
      checksums,
      processingLatenciesPs: latencies,
      maxProcessingLatencyPs: Math.max(...latencies),
      expectedProcessingLatencyPs: resultsIssueCycles(timing) * timing.cyclePs,
      state,
      snapshotCaptureWallSeconds: captured.wallSeconds,
      runUntilCalls: totalRunUntilCalls,
      transferCalls: totalTransferCalls,
      wallSeconds: totalWallSeconds,
    };
  }

  return {
    board,
    oracle,
    config,
    timing,
    description:
      `${timing.width}x${timing.height} 8-bit parallel gray camera at 30 fps and 1 MHz PCLK, ` +
      'full electrical bus into a synthetic nominal-100 MHz MCU DCMI/DMA capture unit; JIT ' +
      `firmware thresholds raw pixels below ${timing.threshold} into binary RAM, maintains a ` +
      '256-bin histogram and counts them.' +
      (config.bus ? ' Transport bypass enabled for the pixel burst.' : ' Per-pin transport.'),
    get progress() {
      return {
        frames: completedFrames,
        time: board.time,
        simulatedSeconds: board.time / 1e12,
        wallSeconds: totalWallSeconds,
        runUntilCalls: totalRunUntilCalls,
        transferCalls: totalTransferCalls,
      };
    },
    get trace() {
      return {
        results: results.slice(),
        frameDone: frameDone.slice(),
        frameTrace: frameTrace.slice(),
      };
    },
    /** Test-only: drive exactly one line burst at the current line start. */
    transferLine,
    readMemory: memory,
    snapshot: captureState,
    stepTo,
    stepFrame,
    verifyFrame,
    verify,
    dispose() {
      if (!disposed) {
        disposed = true;
        board.dispose();
      }
    },
  };
}

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    min: sorted[0],
    median,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    max: sorted.at(-1),
  };
}

function metadata() {
  const info = cpus();
  let version = null;
  try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    // Metadata only; the benchmark does not depend on the package manifest.
  }
  let git;
  try {
    const run = (...args) =>
      execFileSync('git', args, {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    git = { commit: run('rev-parse', 'HEAD'), branch: run('rev-parse', '--abbrev-ref', 'HEAD') };
  } catch {
    git = null;
  }
  return {
    timestamp: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: info[0]?.model ?? null,
    cpuCount: info.length,
    totalMemoryMiB: Math.round(totalmem() / 2 ** 20),
    simulatorVersion: version,
    git,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node packages\\simulator\\bench\\gray-camera.mjs ' +
        '[--samples 3] [--warmup-frames 1] [--execution throughput|precise] [--bus true|false]\n' +
        '160x120 8-bit parallel gray camera at 30 fps and 1 MHz PCLK, full electrical bus, ' +
        '100 MHz synthetic MCU DCMI/DMA, JIT threshold-100 binarization + 256-bin histogram.\n' +
        '--bus true enables the prototype transport bypass for the per-line pixel burst.\n' +
        'Only board.runUntil and the transport bursts are timed. JSON on stdout. Synthetic MCU.',
    );
    return;
  }
  const config = parseArgs(args);
  const sdk = await import('../dist/index.js');
  const bench = create(sdk, config);
  try {
    const phaseStart = performance.now();
    const coldSample = bench.stepFrame();
    const cold = { ...coldSample, gate: bench.verifyFrame(0) };
    const warmup = [];
    for (let frame = 0; frame < config.warmupFrames; frame++) {
      const sample = bench.stepFrame();
      warmup.push({ ...sample, gate: bench.verifyFrame(sample.frame) });
    }
    const warm = [];
    for (let frame = 0; frame < config.samples; frame++) {
      const sample = bench.stepFrame();
      warm.push({ ...sample, gate: bench.verifyFrame(sample.frame) });
    }
    const evidence = bench.verify();
    const phaseWallSeconds = (performance.now() - phaseStart) / 1_000;
    const warmSeconds = warm.reduce((total, sample) => total + sample.simulatedSeconds, 0);
    const warmWallSeconds = warm.reduce((total, sample) => total + sample.wallSeconds, 0);
    const warmupSeconds = warmup.reduce((total, sample) => total + sample.simulatedSeconds, 0);
    const warmupWallSeconds = warmup.reduce((total, sample) => total + sample.wallSeconds, 0);
    const warmRunUntilCalls = warm.reduce((total, sample) => total + sample.runUntilCalls, 0);
    const perPixelWallSeconds = warmWallSeconds / (warm.length * bench.timing.pixels);
    console.log(
      JSON.stringify({
        schema: 'mica-js/simulator/gray-camera-bench@1',
        benchmark: 'gray-camera',
        description: bench.description,
        config: {
          ...config,
          frames: 1 + config.warmupFrames + config.samples,
          cpuQuantumPs: quantumPs,
          threshold: bench.timing.threshold,
          framePeriodPs: bench.timing.framePeriodPs,
          nominalFrameRateHz: nominalFrameRateHz(bench.timing),
          pclkHz: bench.timing.pclkHz,
          geometry: {
            width: bench.timing.width,
            height: bench.timing.height,
            pixels: bench.timing.pixels,
          },
        },
        metadata: metadata(),
        hostTiming: {
          measuredPhaseWallSeconds: phaseWallSeconds,
          note: 'Single-threaded JS execution; the ratio includes untimed oracle gates inside the measured phase.',
        },
        cold,
        warmup: {
          frames: warmup.length,
          samples: warmup,
          simulatedSeconds: warmupSeconds,
          wallSeconds: warmupWallSeconds,
          realTimeFactor: warmupSeconds / warmupWallSeconds,
          note: 'Advanced for steady-state warmup; excluded from performance statistics.',
        },
        warm: {
          samples: warm,
          frames: warm.length,
          simulatedSeconds: warmSeconds,
          wallSeconds: warmWallSeconds,
          realTimeFactor: warmSeconds / warmWallSeconds,
          wallSecondsStatistics: statistics(warm.map((sample) => sample.wallSeconds)),
          realTimeFactorStatistics: statistics(warm.map((sample) => sample.realTimeFactor)),
          runUntilCalls: warmRunUntilCalls,
          transferCalls: warm.reduce((total, sample) => total + sample.transferCalls, 0),
          microsPerPixel: perPixelWallSeconds * 1e6,
        },
        evidence,
        notes: [
          'Timed scope: board.runUntil plus, with --bus, the per-line transport bursts. Setup, oracle gates and the final zero-time snapshot are untimed.',
          'Every frame gate compares all raw DMA bytes, firmware binary bytes and all 256 histogram bins against the independent oracle.',
          'The capture unit samples on the PCLK falling edge and writes raw RAM with zero DMA latency, so a frame completes exactly on the last pixel fall in both transport paths.',
          '--bus replaces only the per-pixel electrical burst: the model still drives VSYNC/HREF electrically and the transport commits the final data/PCLK levels to the electrical layer.',
          'The MCU is a synthetic fixed-cost pixel ISA, not ARM/Cortex-M; nominal 100 MHz cycles are model costs.',
          'PCLK is gated to active lines; data pins hold their last value and are never tri-stated. No bus contention is modeled.',
          'Nominal frame rate is 1e12 / 33333333333 ps = 30.0000000003 fps because time is integer picoseconds.',
        ],
      }),
    );
  } finally {
    bench.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
