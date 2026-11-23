// PROTOTYPE: SPI 屏幕基准测试（含旁路开/关差分与守卫测试）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as sdk from '../dist/index.js';
import {
  burstEndPs,
  create,
  createScreenOracle,
  defaults,
  extrapolate,
  frameEndPs,
  makeTiming,
  normalizeOptions,
  panel,
  parseArgs,
} from './spi-screen.mjs';

const probeBoard = (board) => board[Symbol.for('mica-js.simulator/bus-probe')]();
const semantic = (evidence) => ({
  frames: evidence.frames,
  lastFrame: evidence.lastFrame,
  lastFrameGramMismatches: evidence.lastFrameGramMismatches,
  frameCompletionTimesPs: evidence.frameCompletionTimesPs,
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

const small = { width: 16, height: 8, samples: 1, warmupFrames: 0 };

test('single frame: every GRAM byte, frame ordinal and completion time match the oracle', () => {
  const bench = create(sdk, { ...small, bus: false });
  try {
    assert.equal(bench.board.time, 0, 'create must be cold');
    const sample = bench.stepFrame();
    assert.equal(sample.to, frameEndPs(bench.timing, 0));
    assert.equal(sample.runUntilCalls, 1, 'one runUntil per frame without the bypass');
    const gate = bench.verifyFrame(0);
    assert.equal(gate.bytes, 256);
    assert.equal(gate.gramMismatches, 0);
    assert.equal(gate.frameDoneTimePs, burstEndPs(bench.timing, 0));
    assert.deepEqual(bench.readMemory(), bench.oracle.bytes(0));
    const evidence = bench.verify();
    assert.equal(evidence.state.screen.frames, 1);
    assert.equal(evidence.state.screen.bytesThisFrame, 256);
    assert.equal(evidence.state.screen.byteCount, 0);
    assert.equal(evidence.state.mcu.framesSent, 1);
  } finally {
    bench.dispose();
  }
});

test('differential: bypass on and off are byte-identical over two frames', () => {
  const perPin = runFrames({ ...small, bus: false }, 2);
  const bypass = runFrames({ ...small, bus: true }, 2);
  assert.deepEqual(semantic(bypass), semantic(perPin));
  assert.equal(bypass.transferCalls, 2, 'one transport burst per frame');
});

test('differential: GRAM content is identical byte for byte', () => {
  const read = (bus) => {
    const bench = create(sdk, { ...small, bus });
    try {
      bench.stepFrame();
      return bench.readMemory();
    } finally {
      bench.dispose();
    }
  };
  assert.deepEqual(read(true), read(false));
});

test('guard: precise execution never takes the bypass', () => {
  const bench = create(sdk, { ...small, bus: true, execution: 'precise' });
  try {
    const burst = bench.transferFrame(0);
    assert.equal(burst.accepted, false);
    assert.equal(bench.board.time, 0, 'a rejected transfer must not advance time');
  } finally {
    bench.dispose();
  }
});

test('guard: an undefined resolve on either side never takes the bypass', () => {
  const bench = create(sdk, { ...small, bus: false });
  try {
    assert.equal(bench.transferFrame(0).accepted, false);
    assert.equal(bench.board.time, 0);
  } finally {
    bench.dispose();
  }
});

test('guard: a config mismatch between the two sides prevents the bypass', () => {
  const bench = create(sdk, { ...small, bus: true }, { targetConfig: { mode: 3 } });
  try {
    assert.equal(bench.transferFrame(0).accepted, false);
    assert.equal(bench.board.time, 0);
  } finally {
    bench.dispose();
  }
});

test('guard: a third device on a bus net prevents the bypass', () => {
  const bench = create(sdk, { ...small, bus: true }, { monitorNet: 'sck' });
  try {
    assert.equal(bench.transferFrame(0).accepted, false);
    assert.equal(bench.board.time, 0);
  } finally {
    bench.dispose();
  }
});

test('guard: a third-party subscriber on a bus pin prevents the bypass', () => {
  const bench = create(sdk, { ...small, bus: true });
  try {
    const slot = probeBoard(bench.board).slot('screen', 'sck');
    assert.ok(slot, 'the probe exposes the pin slot');
    const foreign = { instance: {} };
    slot.subscribers.add(foreign);
    try {
      assert.equal(bench.transferFrame(0).accepted, false);
      assert.equal(bench.board.time, 0);
    } finally {
      slot.subscribers.delete(foreign);
    }
    assert.equal(bench.transferFrame(0).accepted, true, 'the same burst succeeds once removed');
    assert.equal(bench.board.time, bench.timing.burstPs);
  } finally {
    bench.dispose();
  }
});

test('panel timing: 320x240 RGB565 is 153600 bytes and fits one 30 fps period', () => {
  const timing = makeTiming(panel.width, panel.height);
  assert.equal(timing.bytes, 153_600);
  assert.equal(timing.rowBytes, 640);
  assert.equal(timing.burstPs, 153_600 * timing.byteTimePs);
  assert.ok(timing.burstPs < timing.framePeriodPs);
  assert.equal(timing.gapPs, timing.framePeriodPs - timing.burstPs);
  assert.equal(timing.sckHz, 50_000_000);
  assert.throws(() => makeTiming(320, 330), /exceeds one 30 fps frame period/);
});

test('extrapolation: measured us/byte scales linearly to the full panel', () => {
  const timing = makeTiming(64, 48);
  const result = extrapolate(timing, 0.6, 3);
  assert.deepEqual(result.measuredGeometry, { width: 64, height: 48, bytes: 6_144 });
  assert.deepEqual(result.panelGeometry, { width: 320, height: 240, bytes: 153_600 });
  assert.ok(Math.abs(result.extrapolatedFrameWallSeconds - 5) < 1e-9);
  assert.ok(Math.abs(result.microsPerByte - (0.2 / 6_144) * 1e6) < 1e-9);
  assert.ok(result.extrapolatedRealTimeFactor > 0);
});

test('independent oracle decomposition agrees with the model pattern', () => {
  const timing = makeTiming(16, 8);
  const oracle = createScreenOracle(timing);
  for (const frame of [0, 3]) {
    const gram = oracle.bytes(frame);
    for (let row = 0; row < timing.height; row++)
      for (let column = 0; column < timing.rowBytes; column++) {
        const index = row * timing.rowBytes + column;
        assert.equal(gram[index], (frame * 37 + index * 29 + row * 17) & 255);
      }
  }
});

test('authoring: option and argument validation', () => {
  assert.deepEqual(defaults, {
    execution: 'throughput',
    samples: 3,
    warmupFrames: 1,
    bus: false,
    width: 64,
    height: 48,
  });
  assert.throws(() => normalizeOptions({ nope: 1 }), /Unknown option/);
  assert.throws(() => normalizeOptions({ width: 0 }), /width/);
  assert.throws(() => normalizeOptions({ width: 321 }), /width/);
  assert.throws(() => normalizeOptions({ bus: 'yes' }), /bus/);
  assert.throws(() => parseArgs(['--samples']), /Missing/);
  assert.throws(() => parseArgs(['--nope', '1']), /Unknown argument/);
  assert.equal(parseArgs(['--bus']).bus, true);
  assert.equal(parseArgs(['--bus', 'false']).bus, false);
  assert.equal(parseArgs(['--width', '16', '--height', '8']).width, 16);
});

test('benchmark entry point emits JSON with schema, evidence and extrapolation', () => {
  const entry = fileURLToPath(new URL('./spi-screen.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--samples', '1', '--warmup-frames', '0'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'mica-js/simulator/spi-screen-bench@1');
  assert.deepEqual(report.config.geometry, {
    width: 64,
    height: 48,
    bytes: 6_144,
    panelBytes: 153_600,
  });
  assert.equal(report.warm.frames, 1);
  assert.equal(report.evidence.lastFrameGramMismatches, 0);
  assert.ok(report.warm.microsPerByte > 0);
  assert.ok(report.extrapolation.extrapolatedFrameWallSeconds > 0);
});
