// PROTOTYPE: 灰度摄像头基准测试（含旁路开/关差分与守卫测试）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as sdk from '../dist/index.js';
import {
  create,
  createGrayCameraOracle,
  defaults,
  frameEndPs,
  frameStartPs,
  limits,
  lineStartPs,
  makeTiming,
  normalizeOptions,
  parseArgs,
  resultsIssueCycles,
} from './gray-camera.mjs';

const probeBoard = (board) => board[Symbol.for('mica-js.simulator/bus-probe')]();
const semantic = (evidence) => ({
  frames: evidence.frames,
  lastFrame: evidence.lastFrame,
  lastFrameRawMismatches: evidence.lastFrameRawMismatches,
  lastFrameBinaryMismatches: evidence.lastFrameBinaryMismatches,
  lastFrameHistogramMismatches: evidence.lastFrameHistogramMismatches,
  frameCompletionTimesPs: evidence.frameCompletionTimesPs,
  resultTimesPs: evidence.resultTimesPs,
  blackCounts: evidence.blackCounts,
  checksums: evidence.checksums,
  processingLatenciesPs: evidence.processingLatenciesPs,
  expectedProcessingLatencyPs: evidence.expectedProcessingLatencyPs,
  state: evidence.state,
});

function runFrames(options, frames = 1, internals = {}) {
  const bench = create(sdk, options, internals);
  try {
    for (let frame = 0; frame < frames; frame++) bench.stepFrame();
    return bench.verify();
  } finally {
    bench.dispose();
  }
}

test('single frame: every raw/binary pixel, histogram, black count and timing match the oracle', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0 }, { width: 16, height: 12 });
  try {
    assert.equal(bench.board.time, 0, 'create must be cold');
    const sample = bench.stepFrame();
    assert.equal(sample.from, 0);
    assert.equal(sample.to, frameEndPs(bench.timing, 0));
    assert.equal(sample.runUntilCalls, 1, 'one runUntil per frame without the bypass');
    const gate = bench.verifyFrame(0);
    assert.equal(gate.pixels, 192);
    assert.equal(gate.rawMismatches, 0);
    assert.equal(gate.binaryMismatches, 0);
    assert.equal(gate.histogramMismatches, 0);
    assert.equal(gate.black, bench.oracle.black(0));
    assert.equal(gate.checksum, bench.oracle.checksum(0));
    assert.equal(gate.frameDoneTimePs, bench.oracle.lastPixelFallPs(0));
    assert.equal(gate.resultTimePs, bench.oracle.resultTimePs(0));
    assert.equal(gate.processingLatencyPs, resultsIssueCycles(bench.timing) * bench.timing.cyclePs);
    const memory = bench.readMemory();
    assert.deepEqual(Uint8Array.from(memory.raw), bench.oracle.raw(0));
    assert.deepEqual(Uint8Array.from(memory.binary), bench.oracle.binary(0));
    const evidence = bench.verify();
    assert.deepEqual(evidence.blackCounts, [bench.oracle.black(0)]);
    assert.equal(evidence.state.dmaFrames, 1);
    assert.equal(evidence.state.processed, 1);
    assert.equal(evidence.state.index, 192);
    assert.equal(evidence.state.pending, 0);
    assert.equal(evidence.state.busy, 0);
  } finally {
    bench.dispose();
  }
});

test('differential: bypass on and off are byte-identical over two frames', () => {
  const internals = { width: 16, height: 12 };
  const perPin = runFrames({ samples: 2, warmupFrames: 0, bus: false }, 2, internals);
  const bypass = runFrames({ samples: 2, warmupFrames: 0, bus: true }, 2, internals);
  assert.deepEqual(semantic(bypass), semantic(perPin));
  assert.equal(bypass.transferCalls, 2 * 12, 'one transport burst per line');
});

test('differential: individual pixel data and frame memory are identical byte for byte', () => {
  const internals = { width: 16, height: 12 };
  const read = (bus) => {
    const bench = create(sdk, { samples: 1, warmupFrames: 0, bus }, internals);
    try {
      bench.stepFrame();
      return bench.readMemory();
    } finally {
      bench.dispose();
    }
  };
  const perPin = read(false);
  const bypass = read(true);
  assert.deepEqual(Uint8Array.from(bypass.raw), Uint8Array.from(perPin.raw));
  assert.deepEqual(Uint8Array.from(bypass.binary), Uint8Array.from(perPin.binary));
  assert.deepEqual(Uint8Array.from(bypass.hist), Uint8Array.from(perPin.hist));
});

test('guard: precise execution never takes the bypass', () => {
  const bench = create(
    sdk,
    { samples: 1, warmupFrames: 0, bus: true, execution: 'precise' },
    { width: 16, height: 12 },
  );
  try {
    bench.stepTo(lineStartPs(bench.timing, 0, 0));
    const before = bench.board.time;
    const burst = bench.transferLine(0, 0);
    assert.equal(burst.accepted, false);
    assert.equal(bench.board.time, before, 'a rejected transfer must not advance time');
  } finally {
    bench.dispose();
  }
});

test('guard: an undefined resolve on either side never takes the bypass', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0, bus: false }, { width: 16, height: 12 });
  try {
    bench.stepTo(lineStartPs(bench.timing, 0, 0));
    const before = bench.board.time;
    assert.equal(bench.transferLine(0, 0).accepted, false);
    assert.equal(bench.board.time, before);
  } finally {
    bench.dispose();
  }
});

test('guard: a third device on a bus net prevents the bypass', () => {
  const bench = create(
    sdk,
    { samples: 1, warmupFrames: 0, bus: true },
    { width: 16, height: 12, monitorNet: 'pclk' },
  );
  try {
    bench.stepTo(lineStartPs(bench.timing, 0, 0));
    assert.equal(bench.transferLine(0, 0).accepted, false);
    assert.equal(bench.board.time, lineStartPs(bench.timing, 0, 0));
  } finally {
    bench.dispose();
  }
});

test('guard: a third-party subscriber on a bus pin prevents the bypass', () => {
  const bench = create(sdk, { samples: 1, warmupFrames: 0, bus: true }, { width: 16, height: 12 });
  try {
    bench.stepTo(lineStartPs(bench.timing, 0, 0));
    const slot = probeBoard(bench.board).slot('mcu', 'pclk');
    assert.ok(slot, 'the probe exposes the pin slot');
    const foreign = { instance: {} };
    slot.subscribers.add(foreign);
    try {
      assert.equal(bench.transferLine(0, 0).accepted, false);
      assert.equal(bench.board.time, lineStartPs(bench.timing, 0, 0));
    } finally {
      slot.subscribers.delete(foreign);
    }
    assert.equal(bench.transferLine(0, 0).accepted, true, 'the same burst succeeds once removed');
    assert.equal(bench.board.time, lineStartPs(bench.timing, 0, 0) + bench.timing.activePs);
  } finally {
    bench.dispose();
  }
});

test('frame timing arithmetic: 160x120 at 30 fps and the pixel/line decomposition', () => {
  const timing = makeTiming(160, 120);
  assert.equal(timing.linePeriodPs, timing.activePs + timing.hblankPs);
  assert.equal(timing.activePs, 160 * timing.pixelPs);
  assert.equal(
    timing.verticalBlankPs,
    timing.framePeriodPs - timing.vsyncPs - 120 * timing.linePeriodPs,
  );
  assert.ok(timing.verticalBlankPs > 0);
  assert.equal(frameEndPs(timing, 0) - frameStartPs(timing, 0), timing.framePeriodPs);
  assert.equal(lineStartPs(timing, 0, 1) - lineStartPs(timing, 0, 0), timing.linePeriodPs);
  assert.throws(() => makeTiming(160, 200), /exceeds the frame period/);
});

test('independent oracle decomposition agrees with the model pattern for every byte value', () => {
  const timing = makeTiming(16, 12);
  const oracle = createGrayCameraOracle(timing);
  for (const frame of [0, 1, 7]) {
    const raw = oracle.raw(frame);
    for (let row = 0; row < timing.height; row++)
      for (let column = 0; column < timing.width; column++) {
        const index = row * timing.width + column;
        assert.equal(
          raw[index],
          (frame * 37 + index * 29 + row * 17) & 255,
          'model and oracle decompositions must agree',
        );
      }
    assert.equal(new Set(raw).size, 192, 'every pixel ordinal carries a distinct byte');
  }
});

test('authoring: option and argument validation', () => {
  assert.deepEqual(defaults, { execution: 'throughput', samples: 3, warmupFrames: 1, bus: false });
  assert.throws(() => normalizeOptions({ nope: 1 }), /Unknown option/);
  assert.throws(() => normalizeOptions({ samples: 0 }), /samples/);
  assert.throws(() => normalizeOptions({ bus: 'yes' }), /bus/);
  assert.throws(() => parseArgs(['--samples']), /Missing/);
  assert.throws(() => parseArgs(['--nope', '1']), /Unknown argument/);
  assert.equal(parseArgs(['--bus']).bus, true);
  assert.equal(parseArgs(['--bus', 'false']).bus, false);
  assert.equal(limits.frames, 36);
});

test('benchmark entry point emits JSON with schema, evidence and per-pixel cost', () => {
  const entry = fileURLToPath(new URL('./gray-camera.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--samples', '1', '--warmup-frames', '0'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'mica-js/simulator/gray-camera-bench@1');
  assert.equal(report.config.geometry.width, 160);
  assert.equal(report.config.geometry.height, 120);
  assert.equal(report.warm.frames, 1);
  assert.equal(report.evidence.lastFrameRawMismatches, 0);
  assert.equal(report.evidence.lastFrameBinaryMismatches, 0);
  assert.equal(report.evidence.lastFrameHistogramMismatches, 0);
  assert.ok(report.warm.microsPerPixel > 0);
  assert.ok(report.warm.realTimeFactor > 0);
});
