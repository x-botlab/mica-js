// PROTOTYPE: SPI 屏幕基准（Level A 传输级旁路验证）。只新建文件，不改动既有基准。
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
  burstEndPs,
  createScreenOracle,
  frameEndPs,
  frameStartPs,
  makeTiming,
  mcuModel,
  mcuSnapshotFields,
  nominalFrameRateHz,
  screenModel,
  screenSnapshotFields,
  signals,
} from './workloads/spi-screen.mjs';

export {
  burstEndPs,
  createScreenOracle,
  defaultTiming as timing,
  frameEndPs,
  frameStartPs,
  makeTiming,
  nominalFrameRateHz,
} from './workloads/spi-screen.mjs';

export const panel = Object.freeze({ width: 320, height: 240 });
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
  width: 64,
  height: 48,
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
  integer(config.width, 1, panel.width, 'width');
  integer(config.height, 1, panel.height, 'height');
  if (config.samples + config.warmupFrames + 1 > limits.frames)
    throw new RangeError('The frame budget is exceeded');
  return Object.freeze(config);
}

export function parseArgs(args) {
  const config = { ...defaults };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (
      !['--samples', '--warmup-frames', '--execution', '--bus', '--width', '--height'].includes(
        argument,
      )
    )
      throw new RangeError(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new RangeError(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === '--bus') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) config.bus = true;
      else {
        index++;
        if (value !== 'true' && value !== 'false')
          throw new RangeError('--bus must be true or false');
        config.bus = value === 'true';
      }
      continue;
    }
    const value = args[++index];
    if (value === undefined) throw new RangeError(`Missing value for ${argument}`);
    if (argument === '--execution') config.execution = value;
    else if (argument === '--samples') config.samples = Number(value);
    else if (argument === '--warmup-frames') config.warmupFrames = Number(value);
    else if (argument === '--width') config.width = Number(value);
    else config.height = Number(value);
  }
  return normalizeOptions(config);
}

const digest = (bytes) => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');

const busConfig = Object.freeze({
  mode: 0,
  bitOrder: 'msb-first',
  bitsPerWord: 8,
  clockKey: 'sck',
  serialKey: 'mosi',
  clockIdle: 'low',
  highPin: 'supply',
  lowPin: 'reference',
  resistance: 25,
});
const busPins = Object.freeze({ sck: 'sck', mosi: 'mosi', cs: 'cs', dc: 'dc' });

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

/**
 * A 320x240 RGB565 SPI panel and one synthetic nominal-100 MHz MCU hardware SPI
 * peripheral. The baseline toggles SCK on every bit and the panel shifts on every
 * rising edge; that is the honest per-edge electrical model. With `bus` enabled the
 * per-bit loop becomes one transport burst per frame and the panel receives the whole
 * byte stream synchronously.
 *
 * The default geometry is 64x48 (3 072 pixels = 6 144 RGB565 bytes) because the per-pin
 * baseline at 320x240 (153 600 bytes, ~2.46 M SCK edges per frame) is not measurable.
 *
 * `internals.monitorNet` adds one passive device on a named bus net (node guard test) and
 * `internals.targetConfig` overrides the panel's config (mismatch guard test).
 */
export function create(sdk, options = {}, internals = {}) {
  const config = normalizeOptions(options);
  if (typeof sdk?.createBoard !== 'function' || typeof sdk?.createDeviceLibrary !== 'function')
    throw new TypeError('Supply the public simulator SDK module');
  for (const key of Object.keys(internals))
    if (!['monitorNet', 'targetConfig'].includes(key))
      throw new TypeError(`Unknown internal option: ${key}`);
  const monitorNet = internals.monitorNet;
  if (monitorNet !== undefined && !signals.includes(monitorNet))
    throw new RangeError('monitorNet must be one of the SPI signals');
  const targetConfig = Object.freeze({ ...busConfig, ...(internals.targetConfig ?? {}) });
  const timing = makeTiming(config.width, config.height);
  const oracle = createScreenOracle(timing);
  const frameDone = [];
  const frameTrace = [];
  let mcu;
  let screen;
  let mcuBus;
  const entries = [
    {
      id: 'mcu',
      model: mcuModel(timing, config.bus),
      create(ctx) {
        mcuBus = ctx.attachBus({
          profile: 'spi',
          role: 'initiator',
          resolve: () => ({ pins: busPins, config: busConfig }),
        });
        mcu = ctx;
        return {
          sync() {},
          dispose() {},
        };
      },
    },
    {
      id: 'screen',
      model: screenModel(timing),
      create(ctx) {
        let byteCount = 0;
        const binding = {
          pins: busPins,
          config: targetConfig,
          onSlice(slice) {
            if (byteCount === timing.bytes) byteCount = 0;
            effects.writeMemory('gram', byteCount, slice.tx);
            byteCount += slice.count;
            effects.writeState('byteCount', byteCount);
            if (byteCount === timing.bytes) {
              effects.writeState('bytesThisFrame', byteCount);
            }
          },
        };
        const endpoint = ctx.attachBus({
          profile: 'spi',
          role: 'target',
          resolve: () => (config.bus ? binding : undefined),
        });
        const effects = endpoint.effects;
        screen = ctx;
        return {
          sync(batch) {
            frameDone.push(...batch.outputs.frameDone);
          },
          dispose() {},
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
    { id: 'mcu', type: 'mcu', props: { bus: config.bus } },
    { id: 'screen', type: 'screen' },
  ];
  if (monitorNet !== undefined) instances.push({ id: 'monitor', type: 'monitor' });
  const nets = [
    ...[
      ['supply', 3.3],
      ['reference', 0],
    ].map(([id, voltage]) => ({
      id,
      voltage,
      pins: [endpoint('mcu', id), endpoint('screen', id)],
    })),
    ...signals.map((id) => ({
      id,
      pins:
        id === monitorNet
          ? [endpoint('mcu', id), endpoint('screen', id), endpoint('monitor', id)]
          : [endpoint('mcu', id), endpoint('screen', id)],
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
  const framesCompletedAt = (time) => Math.max(0, Math.floor(time / timing.framePeriodPs));
  let completedFrames = 0;
  let disposed = false;
  let totalWallSeconds = 0;
  let totalRunUntilCalls = 0;
  let totalTransferCalls = 0;
  const valid = () => {
    if (disposed) throw new Error('SPI screen benchmark is disposed');
  };
  const runTimed = (target) => {
    const start = performance.now();
    board.runUntil(target);
    return (performance.now() - start) / 1_000;
  };
  /** One whole-frame transport burst, timed like a runUntil call. */
  function transferFrame(frame) {
    valid();
    assert.equal(
      board.time,
      frameStartPs(timing, frame),
      'A frame burst starts at the frame start',
    );
    const tx = oracle.bytes(frame);
    const start = performance.now();
    const accepted = mcuBus.transfer({
      totalUnits: timing.bytes,
      unitDurationPs: timing.byteTimePs,
      tx,
    });
    const wallSeconds = (performance.now() - start) / 1_000;
    totalTransferCalls++;
    totalWallSeconds += wallSeconds;
    return { accepted, wallSeconds };
  }
  function stepFrame() {
    valid();
    assert(completedFrames < limits.frames, 'The frame budget is exceeded');
    const frame = completedFrames;
    const from = board.time;
    let wallSeconds = 0;
    let runUntilCalls = 0;
    if (config.bus) {
      wallSeconds += runTimed(frameStartPs(timing, frame));
      runUntilCalls++;
      const burst = transferFrame(frame);
      wallSeconds += burst.wallSeconds;
      assert(burst.accepted, 'The transport burst must be accepted in bus mode');
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
      transferCalls: config.bus ? 1 : 0,
      frame,
      frames: 1,
    };
  }
  function verifyFrame(frame = completedFrames - 1, { digestBytes = false } = {}) {
    valid();
    assert.equal(board.status, 'ready');
    assert(Number.isSafeInteger(frame) && frame >= 0 && frame < completedFrames);
    assert.equal(frameDone.length, completedFrames, 'One panel frame-complete trace per frame');
    const expected = oracle.bytes(frame);
    const gram = screen.memory.gram;
    let mismatches = 0;
    const samples = [];
    for (let index = 0; index < timing.bytes; index++)
      if (gram[index] !== expected[index]) {
        mismatches++;
        if (samples.length < 8)
          samples.push({ index, actual: gram[index], expected: expected[index] });
      }
    assert.equal(
      mismatches,
      0,
      `GRAM differs from the independent oracle: ${JSON.stringify(samples)}`,
    );
    assert.equal(frameDone[frame].value, frame + 1, 'Panel frame ordinal');
    assert.equal(
      frameDone[frame].time,
      burstEndPs(timing, frame),
      'Frame completes at the CS rise',
    );
    return {
      frame,
      bytes: timing.bytes,
      gramMismatches: mismatches,
      checksum: oracle.checksum(frame),
      ...(digestBytes ? { gramDigest: digest(gram) } : {}),
      frameDoneTimePs: frameDone[frame].time,
      burstEndPs: burstEndPs(timing, frame),
    };
  }
  function captureState() {
    valid();
    mcu.inputs.snapshotRequest.notify();
    screen.inputs.snapshotRequest.notify();
    board.runUntil(board.time);
    const mcuBytes = Uint8Array.from(mcu.memory.snapshot);
    const screenBytes = Uint8Array.from(screen.memory.snapshot);
    const mcuView = new DataView(mcuBytes.buffer);
    const screenView = new DataView(screenBytes.buffer);
    return {
      mcu: Object.fromEntries(
        mcuSnapshotFields.map((name, index) => [name, mcuView.getUint32(index * 4, true)]),
      ),
      screen: Object.fromEntries(
        screenSnapshotFields.map((name, index) => [name, screenView.getUint32(index * 4, true)]),
      ),
    };
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
    const frameCompletionTimesPs = [];
    for (let frame = 0; frame < completedFrames; frame++) {
      assert.equal(frameDone[frame].value, frame + 1, 'Complete frame ordinals');
      assert.equal(frameDone[frame].time, burstEndPs(timing, frame), 'Complete frame times');
      frameCompletionTimesPs.push(frameDone[frame].time);
    }
    const state = captureState();
    assert.equal(state.screen.frames, completedFrames, 'Panel received every frame');
    assert.equal(state.screen.bytesThisFrame, timing.bytes, 'Panel received one full frame');
    assert.equal(state.screen.byteCount, 0, 'Panel re-armed for the next frame');
    assert.equal(state.screen.shiftReg, 0, 'Shift register drained');
    assert.equal(state.screen.bitCount, 0, 'No partial byte left');
    assert.equal(state.mcu.framesSent, completedFrames, 'MCU sent every frame');
    assert.equal(state.mcu.frame, completedFrames, 'MCU frame counter');
    assert.equal(state.mcu.byteIndex, 0, 'MCU byte cursor reset for the next frame');
    return {
      frames: completedFrames,
      lastFrame,
      lastFrameGramMismatches: lastFrame.gramMismatches,
      lastFrameGramDigest: lastFrame.gramDigest,
      frameCompletionTimesPs,
      state,
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
      `${timing.width}x${timing.height} RGB565 SPI panel (${timing.bytes} bytes/帧) at ` +
      `${timing.sckHz / 1e6} MHz SCK, mode 0, MSB first; a synthetic nominal-100 MHz MCU ` +
      'hardware SPI peripheral drives CS/DC/SCK/MOSI into an edge-triggered shift-register panel.' +
      (config.bus ? ' Transport bypass enabled for the frame burst.' : ' Per-pin transport.'),
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
      return { frameDone: frameDone.slice(), frameTrace: frameTrace.slice() };
    },
    /** Test-only: drive exactly one frame burst at the current frame start. */
    transferFrame,
    readMemory: () => Uint8Array.from(screen.memory.gram),
    snapshot: captureState,
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

/** Linear extrapolation of the measured per-byte baseline to the full 320x240 frame. */
export function extrapolate(timing, warmWallSeconds, frames) {
  const perFrame = warmWallSeconds / frames;
  const microsPerByte = (perFrame / timing.bytes) * 1e6;
  const panelTiming = makeTiming(panel.width, panel.height);
  const extrapolatedWallSeconds = (microsPerByte * panelTiming.bytes) / 1e6;
  const simulatedSeconds = panelTiming.framePeriodPs / 1e12;
  return {
    measuredGeometry: { width: timing.width, height: timing.height, bytes: timing.bytes },
    panelGeometry: { width: panel.width, height: panel.height, bytes: panelTiming.bytes },
    measuredFrameWallSeconds: perFrame,
    microsPerByte,
    extrapolatedFrameWallSeconds: extrapolatedWallSeconds,
    extrapolatedRealTimeFactor: simulatedSeconds / extrapolatedWallSeconds,
    method:
      '线性外推：实测 µs/byte（含每帧固定开销）乘以 153600 字节；不含 JIT、检查与同步的固定开销变化。',
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node packages\\simulator\\bench\\spi-screen.mjs ' +
        '[--samples 3] [--warmup-frames 1] [--execution throughput|precise] [--bus true|false] ' +
        '[--width 64] [--height 48]\n' +
        '320x240 RGB565 SPI panel: 153600 bytes/frame, 50 MHz SCK, mode 0. The per-pin baseline ' +
        'defaults to 64x48 (3072 bytes) because 320x240 is not measurable per edge; the report ' +
        'extrapolates the measured us/byte linearly to the full panel.\n' +
        '--bus true enables the prototype transport bypass (only useful at 320x240).\n' +
        'Only board.runUntil and the transport burst are timed. JSON on stdout.',
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
    const extrapolation = extrapolate(bench.timing, warmWallSeconds, warm.length);
    console.log(
      JSON.stringify({
        schema: 'mica-js/simulator/spi-screen-bench@1',
        benchmark: 'spi-screen',
        description: bench.description,
        config: {
          ...config,
          frames: 1 + config.warmupFrames + config.samples,
          cpuQuantumPs: quantumPs,
          framePeriodPs: bench.timing.framePeriodPs,
          nominalFrameRateHz: nominalFrameRateHz(bench.timing),
          sckHz: bench.timing.sckHz,
          geometry: {
            width: bench.timing.width,
            height: bench.timing.height,
            bytes: bench.timing.bytes,
            panelBytes: makeTiming(panel.width, panel.height).bytes,
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
          runUntilCalls: warm.reduce((total, sample) => total + sample.runUntilCalls, 0),
          transferCalls: warm.reduce((total, sample) => total + sample.transferCalls, 0),
          microsPerByte: (warmWallSeconds / warm.length / bench.timing.bytes) * 1e6,
        },
        extrapolation,
        evidence,
        notes: [
          'Timed scope: board.runUntil plus, with --bus, the whole-frame transport burst. Setup, oracle gates and the final zero-time snapshot are untimed.',
          'Every frame gate compares all GRAM bytes against the independent panel oracle; the panel itself asserts CS rises only after a complete frame and that every data byte sees DC high.',
          'The baseline toggles SCK once per bit (8 per byte); the panel shifts one MOSI bit on every SCK rising edge. This is the current electrical contract, not a shortcut.',
          '320x240 is 153 600 bytes and ~2.46 M SCK edges per frame; the baseline is measured at 64x48 and extrapolated linearly (see extrapolation.method).',
          'The MCU is a synthetic nominal-100 MHz peripheral model; 50 MHz SCK is a nominal bus rate, not measured silicon.',
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
