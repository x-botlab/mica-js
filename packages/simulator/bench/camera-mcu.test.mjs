import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as sdk from '../dist/index.js';
import {
  create,
  createCameraOracle,
  defaults,
  frameEndPs,
  frameStartPs,
  limits,
  normalizeOptions,
  parseArgs,
  timing,
} from './camera-mcu.mjs';
import {
  lastDmaPs,
  lastPixelRisePs,
  mcuModel,
  nominalFrameRateHz,
  pixelRiseAtPs,
  resultsIssueCycles,
} from './workloads/camera-mcu.mjs';

const semantic = (evidence) => ({
  frames: evidence.frames,
  lastFrame: evidence.lastFrame,
  lastFrameRawMismatches: evidence.lastFrameRawMismatches,
  lastFrameBinaryMismatches: evidence.lastFrameBinaryMismatches,
  lastFrameRawDigest: evidence.lastFrameRawDigest,
  lastFrameBinaryDigest: evidence.lastFrameBinaryDigest,
  frameCompletionTimesPs: evidence.frameCompletionTimesPs,
  resultTimesPs: evidence.resultTimesPs,
  blackCounts: evidence.blackCounts,
  processingLatenciesPs: evidence.processingLatenciesPs,
  maxProcessingLatencyPs: evidence.maxProcessingLatencyPs,
  expectedProcessingLatencyPs: evidence.expectedProcessingLatencyPs,
  state: evidence.state,
});

function runFrames(options, frames = 1) {
  const bench = create(sdk, options);
  try {
    for (let frame = 0; frame < frames; frame++) bench.stepFrame();
    return bench.verify();
  } finally {
    bench.dispose();
  }
}

test('single frame: every raw/binary pixel, black count, completion time and latency match the oracle', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0 });
  try {
    assert.equal(bench.board.time, 0, 'create must be cold');
    const sample = bench.stepFrame();
    assert.equal(sample.from, 0);
    assert.equal(sample.to, frameEndPs(0), 'cold frame ends at the first full frame boundary');
    assert.equal(sample.frames, 1);
    assert.equal(sample.simulatedSeconds, (timing.startPs + timing.framePeriodPs) / 1e12);
    assert.ok(sample.wallSeconds >= 0);
    assert.equal(sample.runUntilCalls, 1, 'one runUntil per frame step');
    const gate = bench.verifyFrame(0);
    const oracle = createCameraOracle();
    assert.equal(gate.pixels, timing.pixels);
    assert.equal(gate.rawMismatches, 0, 'all 2816 DMA bytes');
    assert.equal(gate.binaryMismatches, 0, 'all 2816 firmware bytes');
    const memory = bench.readMemory();
    assert.deepEqual(memory.raw, oracle.raw(0), 'every raw byte equals the independent oracle');
    assert.deepEqual(
      memory.binary,
      oracle.binary(0),
      'every binary byte equals the independent oracle',
    );
    assert.equal(gate.black, oracle.black(0));
    assert.equal(gate.black, 1101);
    assert.equal(gate.nonBlack, timing.pixels - gate.black);
    assert.equal(gate.lastPixelRisePs, lastPixelRisePs(0));
    assert.equal(gate.frameDoneTimePs, lastDmaPs(0));
    assert.equal(gate.dmaDelayPs, timing.dmaPs);
    assert.equal(gate.processingLatencyPs, resultsIssueCycles * timing.cyclePs);
    const isrEnd =
      gate.resultTimePs + (timing.publishCycles + timing.isrExitCycles) * timing.cyclePs;
    assert.ok(isrEnd < frameEndPs(0), 'ISR finishes before the next frame');
    assert.equal(bench.progress.frames, 1);
    assert.equal(bench.progress.time, frameEndPs(0));
    const evidence = bench.verify();
    assert.equal(evidence.frames, 1);
    assert.equal(evidence.lastFrameRawMismatches, 0);
    assert.equal(evidence.lastFrameBinaryMismatches, 0);
    assert.deepEqual(evidence.blackCounts, [1101]);
    assert.deepEqual(evidence.state, {
      dmaIndex: 0,
      dmaFrames: 1,
      framesStarted: 2,
      processingFrame: 1,
      index: 2816,
      black: 1101,
      processed: 1,
      pc: 0,
      pending: 0,
      busy: 0,
    });
    const warm = bench.stepFrame();
    assert.equal(warm.runUntilCalls, 1, 'one runUntil per frame step');
    assert.equal(
      warm.to - warm.from,
      timing.framePeriodPs,
      'warm sample is exactly one full period',
    );
    assert.equal(warm.simulatedSeconds, timing.framePeriodPs / 1e12);
    bench.verifyFrame(1);
  } finally {
    bench.dispose();
  }
});

test('threshold boundary: 99 is black, 100 and 101 are not, and the count follows value < 100', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0 });
  try {
    bench.stepFrame();
    const { raw, binary } = bench.readMemory();
    const positions = new Map();
    for (let index = 0; index < raw.length; index++)
      if (raw[index] === 99 || raw[index] === 100 || raw[index] === 101)
        positions.set(raw[index], index);
    assert.ok(
      positions.has(99) && positions.has(100) && positions.has(101),
      'pattern spans the boundary',
    );
    assert.equal(raw[positions.get(99)], 99);
    assert.equal(binary[positions.get(99)], 0, 'below threshold is black 0');
    assert.equal(binary[positions.get(100)], 1, '100 is not below the threshold');
    assert.equal(binary[positions.get(101)], 1);
    const expected = Uint8Array.from(raw, (value) => (value < 100 ? 0 : 1));
    assert.deepEqual(binary, expected, 'strict < 100 binarization for every pixel');
    assert.equal(
      bench.verifyFrame(0).black,
      expected.reduce((total, value) => total + (value === 0), 0),
    );
  } finally {
    bench.dispose();
  }
});

test('frame timing arithmetic: VSYNC, 64 lines of 505us and blanking cover one 30fps period', () => {
  assert.equal(
    timing.vsyncPs + timing.height * timing.linePeriodPs + timing.verticalBlankPs,
    timing.framePeriodPs,
  );
  assert.equal(timing.linePeriodPs, timing.width * timing.pixelPs + timing.hblankPs);
  assert.ok(timing.hblankPs > 400_000_000);
  assert.ok(timing.verticalBlankPs > 0);
  assert.ok(Math.abs(nominalFrameRateHz - 30) < 1e-9);
  assert.equal(pixelRiseAtPs(0, 1) - pixelRiseAtPs(0, 0), 1_000_000);
  assert.equal(pixelRiseAtPs(0, timing.width) - pixelRiseAtPs(0, timing.width - 1), 462_000_000);
  assert.equal(
    frameEndPs(0) - lastPixelRisePs(0),
    timing.verticalBlankPs + timing.hblankPs + timing.pixelPs / 2,
  );
});

test('independent oracle decomposition covers all 8-bit values and equals the camera pattern', () => {
  const oracle = createCameraOracle();
  for (const frame of [0, 1, 2, 5]) {
    const raw = oracle.raw(frame);
    const binary = oracle.binary(frame);
    assert.equal(new Set(raw).size, 256);
    assert.equal(raw.length, timing.pixels);
    for (let row = 0; row < timing.height; row++)
      for (let column = 0; column < timing.width; column++) {
        const index = row * timing.width + column;
        assert.equal(raw[index], (frame * 37 + index * 29 + row * 17) & 255);
        assert.equal(binary[index], raw[index] < 100 ? 0 : 1);
      }
    assert.equal(
      oracle.black(frame),
      raw.reduce((total, value) => total + (value < 100), 0),
    );
  }
});

for (const sliceMs of [10, 20]) {
  test(`${sliceMs}ms host slicing preserves every frame byte, count, time and latency`, () => {
    const whole = runFrames({ samples: 1, warmupFrames: 0 }, 2);
    const sliced = runFrames({ samples: 1, warmupFrames: 0, sliceMs }, 2);
    assert.deepEqual(semantic(sliced), semantic(whole));
    assert.ok(
      sliced.runUntilCalls > whole.runUntilCalls,
      'host slices must actually split board.runUntil calls',
    );
    assert.equal(sliced.frames, 2);
    assert.deepEqual(sliced.blackCounts, [1101, 1099]);
  });
}

test('irregular host chunks are identical to one whole-frame advancement', () => {
  const whole = runFrames({ samples: 1, warmupFrames: 0 }, 2);
  const bench = create(sdk, { samples: 1, warmupFrames: 0 });
  try {
    const targets = [
      1,
      999_999_999,
      1_000_000_000,
      1_000_000_001,
      1_001_500_000,
      1_001_519_999,
      1_001_520_000,
      2_000_000_000,
      10_000_000_000,
      20_000_000_000,
      33_858_520_000,
      frameEndPs(0) - 1,
      frameEndPs(0),
      frameEndPs(0) + 1,
      frameEndPs(0) + 1_000_000,
      frameEndPs(0) + 33_000_000_000,
      frameEndPs(1),
    ];
    for (const target of targets) bench.stepTo(target);
    assert.equal(
      bench.progress.runUntilCalls,
      targets.length,
      'default stepTo performs exactly one runUntil per target',
    );
    assert.deepEqual(semantic(bench.verify()), semantic(whole));
  } finally {
    bench.dispose();
  }
});

test('precise execution mode preserves the identical camera, RAM and firmware evidence', () => {
  const throughput = runFrames({ samples: 1, warmupFrames: 0 }, 2);
  const precise = runFrames({ samples: 1, warmupFrames: 0, execution: 'precise' }, 2);
  assert.deepEqual(semantic(precise), semantic(throughput));
});

test('one capture per PCLK rising edge, exact 20ns DMA latency and real line blanking', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0 }, { tracePixels: true });
  try {
    bench.stepFrame();
    const { pixelTrace } = bench.trace;
    assert.equal(pixelTrace.length, timing.pixels);
    const oracle = bench.oracle;
    for (let index = 0; index < timing.pixels; index++) {
      assert.equal(
        pixelTrace[index].time,
        oracle.pixelRiseAtPs(0, index) + timing.dmaPs,
        `pixel ${index} is written 20ns after its PCLK rising edge`,
      );
      assert.equal(pixelTrace[index].value, index * 256 + oracle.pixel(0, index));
      if (index + 1 < timing.pixels)
        assert.ok(
          pixelTrace[index].time < oracle.pixelRiseAtPs(0, index + 1),
          'the 20ns DMA wait ends before the next PCLK rising edge',
        );
    }
    assert.equal(pixelTrace[1].time - pixelTrace[0].time, 1_000_000);
    assert.equal(
      pixelTrace[timing.width].time - pixelTrace[timing.width - 1].time,
      462_000_000,
      '461us HREF low plus the next 1us pixel',
    );
    bench.verifyFrame(0);
  } finally {
    bench.dispose();
  }
});

test('raw RAM is unchanged 1ps before the 20ns DMA deadline and written exactly at it', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0 });
  try {
    const rise = pixelRiseAtPs(0, 1);
    bench.stepTo(rise + timing.dmaPs - 1);
    assert.equal(bench.board.time, rise + timing.dmaPs - 1);
    assert.equal(bench.readMemory().raw[0], bench.oracle.pixel(0, 0), 'first byte already stored');
    assert.equal(bench.readMemory().raw[1], 0, 'second byte still holds its initial value');
    bench.stepTo(rise + timing.dmaPs);
    assert.equal(bench.readMemory().raw[1], bench.oracle.pixel(0, 1));
  } finally {
    bench.dispose();
  }
});

test('on processes do not restart per edge: an outstanding 3us DMA wait coalesces and loses pixels', () => {
  const slow = create(sdk, { samples: 1, warmupFrames: 0 }, { dmaDelayPs: 3_000_000 });
  try {
    slow.stepTo(lastPixelRisePs(0) + 1_000_000);
    assert.equal(slow.board.time, lastPixelRisePs(0) + 1_000_000, 'PCLK keeps running');
    const { state } = slow.snapshot();
    assert.ok(state.dmaIndex > 0, 'the capture unit did store some pixels');
    assert.ok(state.dmaIndex < timing.pixels, 'queued single pending run loses later rising edges');
    assert.equal(state.dmaFrames, 0);
    assert.equal(slow.trace.frameDone.length, 0);
    assert.equal(slow.trace.results.length, 0);
  } finally {
    slow.dispose();
  }
  const short = create(sdk, { samples: 1, warmupFrames: 0 }, { dmaDelayPs: 3_000_000 });
  try {
    assert.throws(
      () => short.stepTo(frameEndPs(1)),
      /Every previous camera frame must deliver all pixels before the next VSYNC/,
      'a short frame must fault instead of being accepted',
    );
  } finally {
    short.dispose();
  }
});

test('firmware that overruns the frame faults instead of letting DMA race the single buffer', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0 }, { pixelCycles: 6_000_000 });
  try {
    assert.throws(
      () => bench.stepTo(frameStartPs(1)),
      /Frame overlaps firmware processing/,
      'an ISR still running at the next VSYNC must fault',
    );
  } finally {
    bench.dispose();
  }
});

test('oracle rejects corrupted raw and binary RAM outside timed execution', () => {
  let corruptRaw = false;
  let corruptBinary = false;
  const observed = {
    ...sdk,
    createDeviceLibrary(entries) {
      return sdk.createDeviceLibrary(
        entries.map((entry) =>
          entry.id !== 'mcu'
            ? entry
            : {
                ...entry,
                create(ctx) {
                  const publicMemory = ctx.memory;
                  return entry.create({
                    ...ctx,
                    memory: {
                      get raw() {
                        const bytes = Uint8Array.from(publicMemory.raw);
                        if (corruptRaw) bytes[42] ^= 1;
                        return bytes;
                      },
                      get binary() {
                        const bytes = Uint8Array.from(publicMemory.binary);
                        if (corruptBinary) bytes[42] ^= 1;
                        return bytes;
                      },
                      get snapshot() {
                        return publicMemory.snapshot;
                      },
                    },
                  });
                },
              },
        ),
      );
    },
  };
  const bench = create(observed, { samples: 1, warmupFrames: 0 });
  try {
    bench.stepFrame();
    bench.verifyFrame(0);
    corruptRaw = true;
    assert.throws(
      () => bench.verifyFrame(0),
      /Raw DMA RAM differs from the independent camera oracle/,
    );
    corruptRaw = false;
    corruptBinary = true;
    assert.throws(
      () => bench.verifyFrame(0),
      /Binary RAM differs from the independent threshold oracle/,
    );
  } finally {
    bench.dispose();
  }
});

test('factory wiring declares only the JIT hook and builds one shared camera model', () => {
  const registrations = [];
  const observed = {
    ...sdk,
    createDeviceLibrary(entries) {
      return sdk.createDeviceLibrary(
        entries.map((entry) =>
          entry.id !== 'mcu'
            ? entry
            : {
                ...entry,
                create(ctx) {
                  return entry.create({
                    ...ctx,
                    attachJit(options) {
                      registrations.push(options);
                      return ctx.attachJit(options);
                    },
                  });
                },
              },
        ),
      );
    },
  };
  const a = create(observed, { samples: 1, warmupFrames: 0 }, { tracePixels: true });
  const b = create(sdk, { samples: 1, warmupFrames: 0 });
  try {
    assert.equal(a.board.time, 0);
    assert.equal(b.board.time, 0);
    assert.notEqual(a.board, b.board);
    assert.equal(registrations[0].entry, 'cpu');
    assert.deepEqual(registrations[0].beforeInstruction, {
      when: 'takeIrq',
      call: 'enterIrq',
    });
    assert.equal(registrations[0].polling, undefined);
    const model = mcuModel({ tracePixels: true });
    assert.equal(mcuModel({ tracePixels: true }), model, 'identical test models are shared');
    assert.notEqual(mcuModel(), model);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('options, budgets, progress and disposal are bounded', () => {
  assert.deepEqual(normalizeOptions(), defaults);
  assert.equal(normalizeOptions({ sliceMs: 1_000 }).sliceMs, 1_000);
  assert.equal(normalizeOptions({ warmupFrames: 0 }).warmupFrames, 0);
  for (const options of [
    null,
    [],
    1,
    { execution: 'fast' },
    { samples: 0 },
    { samples: 31 },
    { warmupFrames: 6 },
    { sliceMs: -1 },
    { sliceMs: 1_001 },
    { samples: 30, warmupFrames: 6 },
    { unknown: 1 },
  ])
    assert.throws(() => normalizeOptions(options));
  const bench = create(sdk, { samples: 1, warmupFrames: 0 });
  try {
    assert.deepEqual(bench.progress, {
      frames: 0,
      time: 0,
      simulatedSeconds: 0,
      wallSeconds: 0,
      runUntilCalls: 0,
    });
    for (const target of [-1, 1.5, NaN, Infinity, frameEndPs(limits.frames)])
      assert.throws(() => bench.stepTo(target));
    bench.stepFrame();
    assert.equal(bench.progress.frames, 1);
    assert.equal(bench.progress.time, frameEndPs(0));
    assert.throws(() => bench.stepTo(1), /backwards/);
  } finally {
    bench.dispose();
  }
  bench.dispose();
  assert.throws(() => bench.stepFrame(), /disposed/);
  assert.throws(() => bench.verify(), /disposed/);
  assert.throws(() => bench.readMemory(), /disposed/);
});

test('main guard is import-safe; CLI help and malformed options do not run benchmarks', () => {
  const entry = new URL('./camera-mcu.mjs', import.meta.url);
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(entry.href)})`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  const help = spawnSync(process.execPath, [fileURLToPath(entry), '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.ok(help.stdout.startsWith('Usage: node packages\\simulator\\bench\\camera-mcu.mjs '));
  for (const flag of ['--samples', '--warmup-frames', '--slice-ms', '--execution'])
    assert.ok(help.stdout.includes(flag), `Help documents ${flag}`);
  assert.match(help.stdout, /44x64 8-bit parallel camera/);
  assert.match(help.stdout, /1 timed cold frame/);
  assert.match(help.stdout, /full electrical bus/);
  assert.match(help.stdout, /Only board\.runUntil/);
  assert.match(help.stdout, /Synthetic MCU/);
  const invalid = spawnSync(process.execPath, [fileURLToPath(entry), '--samples', 'NaN'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /samples must be an integer/);
});

test('CLI defaults and argument validation are explicit', () => {
  assert.deepEqual(parseArgs([]), defaults);
  assert.equal(parseArgs(['--samples', '2']).samples, 2);
  assert.equal(parseArgs(['--warmup-frames', '0']).warmupFrames, 0);
  assert.equal(parseArgs(['--slice-ms', '20']).sliceMs, 20);
  assert.equal(parseArgs(['--execution', 'precise']).execution, 'precise');
  for (const args of [
    ['--samples'],
    ['--samples', '0'],
    ['--samples', '31'],
    ['--samples', 'NaN'],
    ['--warmup-frames', '6'],
    ['--slice-ms', '-1'],
    ['--slice-ms', '1001'],
    ['--execution', 'fast'],
    ['--unknown', '1'],
    ['--samples', '2', '--samples', '2'],
  ])
    assert.throws(() => parseArgs(args));
});
