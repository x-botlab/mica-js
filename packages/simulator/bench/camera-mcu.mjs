import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cameraModel,
  createCameraOracle,
  frameEndPs,
  mcuModel,
  nominalFrameRateHz,
  resultsIssueCycles,
  signals,
  snapshotFields,
  timing,
  translator,
} from './workloads/camera-mcu.mjs';

export {
  cameraModel,
  createCameraOracle,
  frameEndPs,
  frameStartPs,
  timing,
} from './workloads/camera-mcu.mjs';

export const limits = Object.freeze({
  frames: 36,
  samples: 30,
  warmupFrames: 5,
  sliceMs: 1_000,
});
export const defaults = Object.freeze({
  execution: 'throughput',
  sliceMs: 0,
  samples: 10,
  warmupFrames: 2,
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
  integer(config.samples, 1, limits.samples, 'samples');
  integer(config.warmupFrames, 0, limits.warmupFrames, 'warmupFrames');
  integer(config.sliceMs, 0, limits.sliceMs, 'sliceMs');
  if (config.samples + config.warmupFrames + 1 > limits.frames)
    throw new RangeError('The frame budget is exceeded');
  return Object.freeze(config);
}

export function parseArgs(args) {
  const config = { ...defaults };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[++index];
    if (value === undefined) throw new RangeError(`Missing value for ${argument}`);
    if (!['--samples', '--warmup-frames', '--slice-ms', '--execution'].includes(argument))
      throw new RangeError(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new RangeError(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === '--execution') config.execution = value;
    else if (argument === '--samples') config.samples = Number(value);
    else if (argument === '--warmup-frames') config.warmupFrames = Number(value);
    else config.sliceMs = Number(value);
  }
  return normalizeOptions(config);
}

const digest = (bytes) => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');

/**
 * One 44x64 8-bit parallel camera and one synthetic nominal-100 MHz MCU with a
 * DCMI-style capture peripheral and DMA. The camera drives a fully electrical
 * 11-wire parallel bus; capture, the 20 ns DMA delay and the raw RAM write are
 * model processes. The JIT firmware alone thresholds raw pixels into binary.
 * Only board.runUntil (including SDK sync) is timed. create() is cold.
 *
 * `internals` exists for tests only: `tracePixels` exposes every DMA write and
 * `dmaDelayPs` builds a deliberately lossy capture unit. Neither changes the
 * benchmark configuration or fakes capture data.
 */
export function create(sdk, options = {}, internals = {}) {
  const config = normalizeOptions(options);
  if (typeof sdk?.createBoard !== 'function' || typeof sdk?.createDeviceLibrary !== 'function')
    throw new TypeError('Supply the public simulator SDK module');
  for (const key of Object.keys(internals))
    if (!['tracePixels', 'dmaDelayPs', 'pixelCycles'].includes(key))
      throw new TypeError(`Unknown internal option: ${key}`);
  const tracePixels = internals.tracePixels === true;
  const dmaDelayPs = internals.dmaDelayPs ?? timing.dmaPs;
  const pixelCycles = internals.pixelCycles ?? timing.pixelCycles;
  integer(dmaDelayPs, 1, 1_000_000_000, 'dmaDelayPs');
  integer(pixelCycles, 1, Number.MAX_SAFE_INTEGER, 'pixelCycles');
  const oracle = createCameraOracle();
  const results = [];
  const frameDone = [];
  const pixelTrace = [];
  let mcu;
  const library = sdk.createDeviceLibrary([
    {
      id: 'camera',
      model: cameraModel(),
      create() {
        return {
          sync() {},
          dispose() {},
        };
      },
    },
    {
      id: 'mcu',
      model: mcuModel({ dmaDelayPs, tracePixels }),
      create(ctx) {
        mcu = ctx;
        const binding = ctx.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          beforeInstruction: { when: 'takeIrq', call: 'enterIrq' },
          translate: translator({ pixelCycles }),
        });
        ctx.loadBytes(
          'code',
          Uint8Array.from({ length: 32 }, (_, index) => index),
        );
        return {
          sync(batch) {
            results.push(...batch.outputs.results);
            frameDone.push(...batch.outputs.frameDone);
            if (tracePixels) pixelTrace.push(...batch.outputs.pixelTrace);
          },
          dispose() {
            binding.dispose();
          },
        };
      },
    },
  ]);
  const endpoint = (instance, pin) => ({ instance, pin });
  const board = sdk.createBoard(
    library,
    {
      instances: [
        { id: 'camera', type: 'camera' },
        { id: 'mcu', type: 'mcu' },
      ],
      nets: [
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
          pins: [endpoint('camera', id), endpoint('mcu', id)],
        })),
      ],
    },
    { execution: config.execution, cpuQuantum: quantumPs },
  );
  assert.equal(board.time, 0, 'create() must not advance the board');
  const slicePs = config.sliceMs * 1e9;
  const framesCompletedAt = (time) =>
    Math.max(0, Math.floor((time - timing.startPs) / timing.framePeriodPs));
  let completedFrames = 0;
  let disposed = false;
  let totalWallSeconds = 0;
  let totalRunUntilCalls = 0;
  const valid = () => {
    if (disposed) throw new Error('Camera benchmark is disposed');
  };
  const memory = () => {
    valid();
    return {
      raw: Uint8Array.from(mcu.memory.raw),
      binary: Uint8Array.from(mcu.memory.binary),
    };
  };

  function stepTo(target) {
    valid();
    integer(target, 0, frameEndPs(limits.frames - 1), 'target ps');
    if (target < board.time) throw new RangeError('Cannot run backwards');
    const from = board.time;
    let wallSeconds = 0;
    let runUntilCalls = 0;
    while (board.time < target) {
      const next =
        slicePs > 0 ? Math.min(target, (Math.floor(board.time / slicePs) + 1) * slicePs) : target;
      const start = performance.now();
      board.runUntil(next);
      wallSeconds += (performance.now() - start) / 1_000;
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
    const sample = stepTo(frameEndPs(frame));
    assert.equal(completedFrames, frame + 1, 'A frame step must complete exactly one frame');
    return { ...sample, frame, frames: 1 };
  }

  function verifyFrame(frame = completedFrames - 1, { digestBytes = false } = {}) {
    valid();
    assert.equal(board.status, 'ready');
    assert(Number.isSafeInteger(frame) && frame >= 0 && frame < completedFrames);
    assert.equal(frame, completedFrames - 1, 'Only the most recent camera frame remains in RAM');
    assert.equal(frameDone.length, completedFrames, 'One frame-complete trace per frame');
    assert.equal(results.length, completedFrames, 'One firmware result per frame');
    const expected = oracle.frame(frame);
    const raw = mcu.memory.raw;
    const binary = mcu.memory.binary;
    let rawMismatches = 0;
    let binaryMismatches = 0;
    const rawSamples = [];
    const binarySamples = [];
    for (let index = 0; index < timing.pixels; index++) {
      if (raw[index] !== expected.raw[index]) {
        rawMismatches++;
        if (rawSamples.length < 8)
          rawSamples.push({ index, actual: raw[index], expected: expected.raw[index] });
      }
      if (binary[index] !== expected.binary[index]) {
        binaryMismatches++;
        if (binarySamples.length < 8)
          binarySamples.push({ index, actual: binary[index], expected: expected.binary[index] });
      }
    }
    assert.equal(
      rawMismatches,
      0,
      `Raw DMA RAM differs from the independent camera oracle: ${JSON.stringify(rawSamples)}`,
    );
    assert.equal(
      binaryMismatches,
      0,
      `Binary RAM differs from the independent threshold oracle: ${JSON.stringify(binarySamples)}`,
    );
    const done = frameDone[frame];
    const result = results[frame];
    assert.equal(done.value, frame + 1, 'Frame-complete ordinal');
    assert.equal(done.time, oracle.lastDmaPs(frame), 'Frame completion is last-pixel DMA time');
    assert.equal(result.value, expected.black, 'Black pixel count');
    assert.equal(result.time, oracle.resultTimePs(frame), 'Firmware result publication time');
    return {
      frame,
      pixels: timing.pixels,
      black: result.value,
      nonBlack: timing.pixels - result.value,
      rawMismatches,
      binaryMismatches,
      ...(digestBytes ? { rawDigest: digest(raw), binaryDigest: digest(binary) } : {}),
      frameDoneTimePs: done.time,
      lastPixelRisePs: oracle.lastPixelRisePs(frame),
      dmaDelayPs: done.time - oracle.lastPixelRisePs(frame),
      resultTimePs: result.time,
      processingLatencyPs: result.time - done.time,
      expectedProcessingLatencyPs: resultsIssueCycles * timing.cyclePs,
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
    assert.equal(board.time, frameEndPs(completedFrames - 1), 'Frames advance one period each');
    const last = completedFrames - 1;
    const lastFrame = verifyFrame(last, { digestBytes: true });
    for (let frame = 0; frame < completedFrames; frame++) {
      assert.equal(frameDone[frame].value, frame + 1, 'Complete frame ordinals');
      assert.equal(frameDone[frame].time, oracle.lastDmaPs(frame), 'Complete frame times');
      assert.equal(results[frame].value, oracle.black(frame), 'Complete per-frame black counts');
      assert.equal(results[frame].time, oracle.resultTimePs(frame), 'Complete result times');
    }
    const captured = captureState();
    const { state } = captured;
    assert.equal(state.dmaFrames, completedFrames, 'DMA completed every camera frame');
    assert.equal(state.framesStarted, completedFrames + 1, 'Capture unit saw the next VSYNC');
    assert.equal(state.processed, completedFrames, 'Firmware processed every frame');
    assert.equal(state.processingFrame, completedFrames, 'Firmware saw each frame ordinal');
    assert.equal(state.index, timing.pixels, 'Firmware scanned every pixel');
    assert.equal(state.black, oracle.black(last), 'Final black pixel count');
    assert.equal(state.pc, 0, 'Firmware is waiting for the next frame');
    assert.equal(state.pending, 0, 'No unserviced frame IRQ');
    assert.equal(state.busy, 0, 'Firmware is not processing');
    assert.equal(state.dmaIndex, 0, 'Capture unit is re-armed for the next frame');
    const latencies = results.map((message, frame) => message.time - frameDone[frame].time);
    return {
      frames: completedFrames,
      lastFrame,
      lastFrameRawMismatches: lastFrame.rawMismatches,
      lastFrameBinaryMismatches: lastFrame.binaryMismatches,
      lastFrameRawDigest: lastFrame.rawDigest,
      lastFrameBinaryDigest: lastFrame.binaryDigest,
      frameCompletionTimesPs: frameDone.map((message) => message.time),
      resultTimesPs: results.map((message) => message.time),
      blackCounts: results.map((message) => message.value),
      processingLatenciesPs: latencies,
      maxProcessingLatencyPs: Math.max(...latencies),
      expectedProcessingLatencyPs: resultsIssueCycles * timing.cyclePs,
      state,
      snapshotCaptureWallSeconds: captured.wallSeconds,
      runUntilCalls: totalRunUntilCalls,
      wallSeconds: totalWallSeconds,
    };
  }

  return {
    board,
    oracle,
    config,
    description:
      '44x64 8-bit parallel camera at 30 fps and 1 MHz PCLK driving a fully electrical ' +
      '11-wire bus into a synthetic nominal-100 MHz MCU DCMI/DMA capture unit; JIT firmware ' +
      'thresholds raw pixels below 100 into binary RAM and counts them. No host JS capture or binarization.',
    get progress() {
      return {
        frames: completedFrames,
        time: board.time,
        simulatedSeconds: board.time / 1e12,
        wallSeconds: totalWallSeconds,
        runUntilCalls: totalRunUntilCalls,
      };
    },
    get trace() {
      return {
        results: results.slice(),
        frameDone: frameDone.slice(),
        pixelTrace: pixelTrace.slice(),
      };
    },
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

function gitMetadata() {
  try {
    const run = (...args) =>
      execFileSync('git', args, {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return {
      commit: run('rev-parse', 'HEAD'),
      branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
      dirty: status.length > 0,
      dirtyEntries: status ? status.split('\n').filter(Boolean).length : 0,
    };
  } catch {
    return null;
  }
}

function metadata() {
  const info = cpus();
  let version = null;
  try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    // Metadata only; the benchmark does not depend on the package manifest.
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
    cpuSpeedMHz: info[0]?.speed ?? null,
    totalMemoryMiB: Math.round(totalmem() / 2 ** 20),
    execArgv: process.execArgv,
    cwd: process.cwd(),
    simulatorVersion: version,
    git: gitMetadata(),
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node packages\\simulator\\bench\\camera-mcu.mjs ' +
        '[--samples 10] [--warmup-frames 2] [--slice-ms 0] [--execution throughput|precise]\n' +
        '44x64 8-bit parallel camera at 30 fps and 1 MHz PCLK, full electrical bus, ' +
        '100 MHz synthetic MCU DCMI/DMA, JIT threshold-100 binarization.\n' +
        'Default: 1 timed cold frame + 2 warmup frames excluded from statistics + 10 timed steady frames.\n' +
        'Each sample advances one complete frame period including VSYNC and both blanking intervals. ' +
        'Only board.runUntil (including SDK sync) is timed; the per-frame oracle gates and the ' +
        'final snapshot are untimed. --slice-ms N splits each runUntil at N-ms host boundaries ' +
        '(0 = one call per frame). Bounds: samples 1..30, warmup-frames 0..5, slice-ms 0..1000, ' +
        'total frames <=36. JSON on stdout. Synthetic MCU, not ARM/Cortex-M.',
    );
    return;
  }
  const config = parseArgs(args);
  const sdk = await import('../dist/index.js');
  const bench = create(sdk, config);
  try {
    const phaseStart = performance.now();
    const cpuStart = process.cpuUsage();
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
    const cpu = process.cpuUsage(cpuStart);
    const warmSeconds = warm.reduce((total, sample) => total + sample.simulatedSeconds, 0);
    const warmWallSeconds = warm.reduce((total, sample) => total + sample.wallSeconds, 0);
    const warmupSeconds = warmup.reduce((total, sample) => total + sample.simulatedSeconds, 0);
    const warmupWallSeconds = warmup.reduce((total, sample) => total + sample.wallSeconds, 0);
    console.log(
      JSON.stringify({
        schema: 'mica-js/simulator/camera-bench@1',
        benchmark: 'camera-mcu',
        description: bench.description,
        config: {
          ...config,
          frames: 1 + config.warmupFrames + config.samples,
          cpuQuantumPs: quantumPs,
          threshold: timing.threshold,
          dmaDelayPs: timing.dmaPs,
          framePeriodPs: timing.framePeriodPs,
          nominalFrameRateHz,
          pclkHz: timing.pclkHz,
          geometry: { width: timing.width, height: timing.height, pixels: timing.pixels },
        },
        metadata: metadata(),
        hostTiming: {
          measuredPhaseWallSeconds: phaseWallSeconds,
          processCpuUserSeconds: cpu.user / 1e6,
          processCpuSystemSeconds: cpu.system / 1e6,
          processCpuUtilization: (cpu.user + cpu.system) / 1e6 / phaseWallSeconds,
          note: 'Single-threaded JS execution. The ratio includes untimed oracle gates inside the measured phase; below 1 can indicate host contention, above 1 reflects concurrent V8/GC threads.',
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
          runUntilCalls: warm.reduce((total, sample) => total + sample.runUntilCalls, 0),
          perFrameOracleGates: warm.map((sample) => ({
            frame: sample.frame,
            rawMismatches: sample.gate.rawMismatches,
            binaryMismatches: sample.gate.binaryMismatches,
            black: sample.gate.black,
            processingLatencyPs: sample.gate.processingLatencyPs,
          })),
        },
        evidence,
        notes: [
          'Timed scope: board.runUntil only, including SDK sync and all electrical solves. Setup, the per-frame oracle gates and the final zero-time snapshot capture are untimed.',
          'Every frame gate compares all 2816 raw DMA bytes and all 2816 firmware binary bytes against the independent oracle before the next frame overwrites single-buffer RAM.',
          'Single-buffer raw RAM; the DMA and firmware never overlap because one frame period is far longer than the 169.09 us ISR. Overlap is asserted by the model, not hidden.',
          'No bus contention is modeled: one DMA writer and one CPU reader on a single RAM port, never concurrent.',
          'PCLK is gated to active lines (no dummy clock during blanking); data pins hold their last value and are never tri-stated.',
          'Frame timing is an assumption, not a consequence: 30 fps, 44x64 and 1 MHz PCLK fix only the 33.333333333 ms period and the 2.816 ms of active pixel time per frame. The chosen 1 ms VSYNC, 505 us lines (44 us active + 461 us blanking) and 13.333333 us field blanking are one possible split; moving blanking into the vertical interval would change idle windows and scheduling, so these numbers apply only to this timing.',
          'The MCU is a synthetic fixed-cost pixel ISA, not ARM/Cortex-M; nominal 100 MHz cycles are model costs, not measured silicon.',
          'The camera starts at 1 ms. The cold sample includes lazy board/JIT/code compilation; warmup and steady frames are consecutive full frame periods including VSYNC and both blanking intervals.',
          'Every frame end is checked against the independent oracle; missing edges or a short frame fault the board at the next VSYNC instead of being reported as success.',
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
